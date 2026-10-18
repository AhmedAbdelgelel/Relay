import { beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { metrics } from "../../src/observability/metrics.js";
import { laneAuth } from "../helpers/lane.js";
import { makeApp, ScriptedProvider, sleep } from "./harness.js";

const lanes = await laneAuth("mock");
const ASK = { model: "m", messages: [{ role: "user", content: "abort club" }] };

beforeEach(() => metrics.reset());

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

function gatedFlight() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { entered: 0 };
  const provider = new ScriptedProvider("mock", {
    chat: async (req) => {
      state.entered++;
      await gate;
      return { id: "sf", model: req.model, content: "leader answer", usage: { prompt_tokens: 3, completion_tokens: 2 } };
    },
  });
  return { provider, state, release: () => release() };
}

async function startApp(provider: ScriptedProvider) {
  const { app } = makeApp({ auth: lanes.auth, provider });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/chat/completions`;
  return { app, url };
}

function post(url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lanes.laneFor("mock").key}` },
    body: JSON.stringify(ASK),
    ...(signal ? { signal } : {}),
  });
}

describe("single-flight waiter abort", () => {
  it("a coalesced waiter aborting leaves the leader served and the flight reusable", async () => {
    const { provider, state, release } = gatedFlight();
    const { app, url } = await startApp(provider);
    const pending: Promise<unknown>[] = [];
    try {
      const leader = post(url);
      pending.push(leader);
      await until(() => state.entered === 1);

      const ctrl = new AbortController();
      const follower = post(url, ctrl.signal);
      pending.push(follower);
      await until(() => metrics.snapshot().singleflight_coalesced === 1);
      ctrl.abort();
      await expect(follower).rejects.toThrow();
      release();

      const leaderRes = await leader;
      expect(leaderRes.status).toBe(200);
      expect(leaderRes.headers.get("x-coalesced")).toBe("false");
      const leaderBody = (await leaderRes.json()) as { choices: { message: { content: string } }[] };
      expect(leaderBody.choices[0]!.message.content).toBe("leader answer");
      expect(provider.calls).toBe(1);

      const replay = await post(url);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("x-cache")).toBe("HIT");
      expect(provider.calls).toBe(1);

      const m = metrics.snapshot();
      expect(m.singleflight_leaders).toBe(1);
      expect(m.singleflight_coalesced).toBe(1);
      expect(m.provider_requests).toBe(1);
      expect(m.exact_hits).toBe(1);
    } finally {
      release();
      await Promise.allSettled(pending);
      app.server.closeAllConnections();
      await app.close();
    }
  }, 15000);

  it("aborting the leader leaves coalesced followers waiting and served", async () => {
    const { provider, state, release } = gatedFlight();
    const { app, url } = await startApp(provider);
    const pending: Promise<unknown>[] = [];
    try {
      const ctrl = new AbortController();
      const leader = post(url, ctrl.signal);
      pending.push(leader);
      await until(() => state.entered === 1);

      const follower = post(url);
      pending.push(follower);
      await until(() => metrics.snapshot().singleflight_coalesced === 1);
      ctrl.abort();
      await expect(leader).rejects.toThrow();
      release();

      const followerRes = await follower;
      expect(followerRes.status).toBe(200);
      expect(followerRes.headers.get("x-coalesced")).toBe("true");
      const body = (await followerRes.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0]!.message.content).toBe("leader answer");
      expect(provider.calls).toBe(1);

      const replay = await post(url);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("x-cache")).toBe("HIT");
      expect(provider.calls).toBe(1);

      const m = metrics.snapshot();
      expect(m.singleflight_leaders).toBe(1);
      expect(m.singleflight_coalesced).toBe(1);
      expect(m.provider_requests).toBe(1);
    } finally {
      release();
      await Promise.allSettled(pending);
      app.server.closeAllConnections();
      await app.close();
    }
  }, 15000);
});

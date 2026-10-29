
// Request-schema compatibility (correctness task 2).
//
// The supported chat surface is exactly: model, messages, temperature,
// max_tokens, stream, top_p, stop. Anything else is REJECTED with a 400
// invalid_request naming the offending field — never silently stripped (a
// stripped `tools`/`n`/`penalty` would make the gateway answer a different
// request than the caller asked for, then cache it under the caller's
// identity). Rejection must happen before any provider spend or cache touch.

import { beforeEach, describe, expect, it } from "vitest";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { metrics } from "../../src/observability/metrics.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, json, makeApp, ScriptedProvider } from "./harness.js";

const lanes = await laneAuth("mock");
const lane = () => lanes.laneFor("mock").key;

const base = () => ({ model: "m", messages: [{ role: "user", content: "schema probe" }] });

function spyCache(): CacheRepository & { sets: string[] } {
  const inner = new InMemoryCache();
  const sets: string[] = [];
  return {
    name: "spy",
    sets,
    get: (k) => inner.get(k),
    set: (k, v, ttl) => {
      sets.push(k);
      return inner.set(k, v, ttl);
    },
    del: (k) => inner.del(k),
    ping: () => inner.ping(),
    close: () => inner.close(),
  };
}

beforeEach(() => metrics.reset());

describe("supported request fields", () => {
  it("top_p and stop are accepted, validated and forwarded to the provider unchanged", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });

    const res = await chat(app, lane(), { ...base(), top_p: 0.5, stop: ["END", "STOP"] });
    expect(res.statusCode).toBe(200);
    expect(provider.calls).toBe(1);
    const seen = provider.requests[0]!;
    expect(seen.top_p).toBe(0.5);
    expect(seen.stop).toEqual(["END", "STOP"]);

    // Boundary values are valid: top_p 0 and 1, a single stop string, 4 stops.
    const zero = await chat(app, lane(), { ...base(), top_p: 0 });
    expect(zero.statusCode).toBe(200);
    const one = await chat(app, lane(), { ...base(), top_p: 1 });
    expect(one.statusCode).toBe(200);
    const single = await chat(app, lane(), { ...base(), stop: "ONE" });
    expect(single.statusCode).toBe(200);
    expect(provider.requests[3]!.stop).toBe("ONE");
    const four = await chat(app, lane(), { ...base(), stop: ["a", "b", "c", "d"] });
    expect(four.statusCode).toBe(200);
    expect(provider.calls).toBe(5);
    await app.close();
  });

  it("top_p and stop are part of the request cache identity (supported fields do not alias)", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, env: { SEMANTIC_ENABLED: "false" } });

    const first = await chat(app, lane(), { ...base(), top_p: 0.5 });
    expect(first.headers["x-cache"]).toBe("MISS");
    const plain = await chat(app, lane(), base());
    expect(plain.headers["x-cache"]).toBe("MISS");
    expect(plain.headers["x-cache-hash"]).not.toBe(first.headers["x-cache-hash"]);
    expect((await chat(app, lane(), { ...base(), top_p: 0.5 })).headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(2);
    await app.close();
  });
});

describe("invalid supported values are 400 invalid_request", () => {
  it("rejects out-of-range top_p and malformed stop before any provider spend", async () => {
    const provider = new ScriptedProvider("mock");
    const cache = spyCache();
    const { app } = makeApp({ auth: lanes.auth, provider, cache });

    const cases: { payload: Record<string, unknown>; field: string }[] = [
      { payload: { ...base(), top_p: 2 }, field: "top_p" },
      { payload: { ...base(), top_p: -0.1 }, field: "top_p" },
      { payload: { ...base(), top_p: "0.5" }, field: "top_p" },
      { payload: { ...base(), stop: "" }, field: "stop" },
      { payload: { ...base(), stop: 5 }, field: "stop" },
      { payload: { ...base(), stop: ["a", "b", "c", "d", "e"] }, field: "stop" },
      { payload: { ...base(), stop: ["ok", "x".repeat(129)] }, field: "stop" },
      { payload: { ...base(), stop: [1, 2] }, field: "stop" },
    ];
    for (const { payload, field } of cases) {
      const res = await chat(app, lane(), payload);
      expect(res.statusCode).toBe(400);
      const body = json<{ error: { code: string; message: string; request_id: string } }>(res);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain(field);
      expect(res.headers["x-lane"]).toBeUndefined();
    }
    expect(provider.calls).toBe(0);
    expect(cache.sets).toEqual([]);
    expect(metrics.snapshot().requests_total).toBe(0);
    await app.close();
  });
});

describe("unsupported fields are rejected, never stripped", () => {
  const unsupported: Record<string, unknown>[] = [
    { tools: [{ type: "function" }] },
    { tool_choice: "auto" },
    { response_format: { type: "json_object" } },
    { n: 2 },
    { logprobs: true },
    { top_logprobs: 3 },
    { presence_penalty: 0.5 },
    { frequency_penalty: 0.5 },
    { seed: 7 },
    { user: "u-1" },
    { parallel_tool_calls: false },
    { metadata: { a: 1 } },
  ];

  it("every unknown key is a 400 invalid_request naming that key, before provider spend", async () => {
    const provider = new ScriptedProvider("mock");
    const cache = spyCache();
    const { app } = makeApp({ auth: lanes.auth, provider, cache });

    for (const extra of unsupported) {
      const res = await chat(app, lane(), { ...base(), ...extra });
      expect(res.statusCode).toBe(400);
      const body = json<{ error: { code: string; message: string; request_id: string } }>(res);
      expect(body.error.code).toBe("invalid_request");
      const key = Object.keys(extra)[0]!;
      expect(body.error.message).toContain(key);
      expect(body.error.message).toContain("unsupported field");
      expect(res.headers["x-lane"]).toBeUndefined();
      expect(res.headers["x-cache-hash"]).toBeUndefined();
    }
    expect(provider.calls).toBe(0);
    expect(cache.sets).toEqual([]);
    // Rejections never enter the cache and never count as served requests.
    expect(metrics.snapshot().requests_total).toBe(0);
    expect(metrics.snapshot().exact_misses).toBe(0);
    await app.close();
  });

  it("the supported fields themselves stay accepted after strictness is applied", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, lane(), {
      model: "m",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "all supported fields" },
      ],
      temperature: 0.2,
      max_tokens: 16,
      stream: false,
      top_p: 0.9,
      stop: "END",
    });
    expect(res.statusCode).toBe(200);
    expect(provider.calls).toBe(1);
    await app.close();
  });
});

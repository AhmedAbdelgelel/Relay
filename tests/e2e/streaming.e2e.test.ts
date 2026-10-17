
import { beforeEach, describe, expect, it } from "vitest";
import { GatewayError } from "../../src/domain/types.js";
import { metrics } from "../../src/observability/metrics.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, joinedDeltas, makeApp, parseSSE, ScriptedProvider, sleep } from "./harness.js";

const lanes = await laneAuth("mock");
const key = () => lanes.laneFor("mock").key;
const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "m",
  messages: [{ role: "user", content }],
  stream: true,
  ...extra,
});

beforeEach(() => metrics.reset());

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

describe("SSE happy paths", () => {
  it("deltas stream in order, usage arrives on the terminal frame, [DONE] closes", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, key(), ask("stream please"));
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    expect(res.headers["x-lane"]).toBe("registered");
    expect(res.headers["x-key-id"]).toBe(lanes.laneFor("mock").keyId);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-cache-hash"]).toBeTruthy();
    expect(res.headers["x-provider"]).toBe("mock");
    expect(Number.isFinite(Number(res.headers["x-latency-ms"]))).toBe(true);

    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(frames.length).toBe(4);
    expect(joinedDeltas(frames)).toBe("m stream (e2e)");
    const terminal = frames[3]!;
    expect(terminal["choices"]).toEqual([]);
    expect(terminal["usage"]).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(metrics.snapshot().tokens_out).toBe(5);
    await app.close();
  });

  it("normalizer strips markup across chunk boundaries (split ** markers)", async () => {
    const provider = new ScriptedProvider("mock", {
      stream: async function* () {
        yield { delta: "**bo" };
        yield { delta: "ld**" };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, key(), ask("markup please"));
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(joinedDeltas(frames)).toBe("bold");
    await app.close();
  });

  it("a stream without usage sends no terminal usage frame", async () => {
    const provider = new ScriptedProvider("mock", {
      stream: async function* () {
        yield { delta: "no usage here" };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, key(), ask("no usage"));
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(frames.length).toBe(1);
    expect(frames[0]!["usage"]).toBeUndefined();
    await app.close();
  });

  it("an empty stream still owes headers and [DONE]", async () => {
    const provider = new ScriptedProvider("mock", { stream: async function* () {} });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, key(), ask("empty stream"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(frames.length).toBe(0);
    await app.close();
  });

  it("anonymous streaming is legal and labelled", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, null, ask("anon stream"), { "x-provider-key": "sk-anon" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-lane"]).toBe("anonymous");
    expect(res.headers["x-key-id"]).toBeUndefined();
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(parseSSE(res.body).done).toBe(true);
    await app.close();
  });
});

describe("pre-first-token failures are real JSON statuses", () => {
  it("retryable 429: retried inside the target, then surfaced with retry_after", async () => {
    const provider = new ScriptedProvider("mock", {
      stream: async function* () {
        throw new GatewayError(429, "provider_rate_limited", "mock rate limited. Please retry in 12s.", true);
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, key(), ask("rate limited"));
    expect(res.statusCode).toBe(429);
    expect(String(res.headers["content-type"])).toContain("application/json");
    const body = JSON.parse(res.body) as { error: { code: string; retry_after?: string } };
    expect(body.error.code).toBe("provider_rate_limited");
    expect(body.error.retry_after).toBe("12s");
    expect(res.headers["x-lane"]).toBe("registered");
    expect(res.headers["x-key-id"]).toBe(lanes.laneFor("mock").keyId);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(provider.streamCalls).toBe(3);
    await app.close();
  });

  it("non-retryable 502 fails over once and answers JSON", async () => {
    const provider = new ScriptedProvider("mock", {
      stream: async function* () {
        throw new GatewayError(502, "provider_auth_error", "mock auth failed", false);
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, key(), ask("auth fail"));
    expect(res.statusCode).toBe(502);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe("provider_auth_error");
    expect(provider.streamCalls).toBe(1);
    await app.close();
  });

  it("upstream timeout aborts the provider and surfaces 504 gateway_timeout", async () => {
    const provider = new ScriptedProvider("mock", {
      stream: async function* (_req, signal) {
        await abortable(500, signal);
        yield { delta: "too late" };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider, env: { UPSTREAM_TIMEOUT_MS: "60" } });
    const started = Date.now();
    const res = await chat(app, key(), ask("stall please"));
    expect(res.statusCode).toBe(504);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe("gateway_timeout");
    expect(Date.now() - started).toBeLessThan(450);
    expect(provider.streamCalls).toBe(1);
    await app.close();
  });
});

describe("mid-stream failures", () => {
  it("closes the stream after the partial text; no [DONE], no retry, no failover", async () => {
    const primary = new ScriptedProvider("mock", {
      stream: async function* () {
        yield { delta: "partial" };
        await sleep(5);
        throw new GatewayError(500, "provider_error", "primary died mid-stream", true);
      },
    });
    const fallback = new ScriptedProvider("alt");
    const providers = new Map([
      ["mock", primary],
      ["alt", fallback],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const res = await chat(app, key(), ask("die midway"));
    expect(res.statusCode).toBe(200);
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(false);
    expect(joinedDeltas(frames)).toBe("partial");
    expect(res.body).not.toContain("[DONE]");
    expect(primary.streamCalls).toBe(1);
    expect(fallback.streamCalls).toBe(0);
    expect(res.headers["x-fallback"]).toBeUndefined();
    await app.close();
  });

  it("pre-token failure DOES fail over; the healthy target serves the SSE", async () => {
    const primary = new ScriptedProvider("mock", {
      stream: async function* () {
        throw new GatewayError(502, "provider_error", "primary down", false);
      },
    });
    const fallback = new ScriptedProvider("alt");
    const providers = new Map([
      ["mock", primary],
      ["alt", fallback],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const res = await chat(app, key(), ask("failover please"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("alt");
    expect(res.headers["x-fallback"]).toBe("true");
    const { frames, done } = parseSSE(res.body);
    expect(done).toBe(true);
    expect(joinedDeltas(frames)).toBe("m stream (e2e)");
    expect(primary.streamCalls).toBe(1);
    expect(fallback.streamCalls).toBe(1);
    expect(metrics.snapshot().fallback_count).toBe(1);
    await app.close();
  });
});

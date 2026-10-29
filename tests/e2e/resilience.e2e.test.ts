// tests/e2e/resilience.e2e.test.ts — failure and stress behaviour of the real
// request path (new file; tests/e2e/harness.ts is reused read-only).
//
// Scope: gaps verified as NOT already covered by the default sweep. Existing
// suites already cover: a generic throwing semantic store (semantic-cache),
// a throwing CacheRepository + a dead-port RedisCache (exact-cache), a hanging
// OpenAI-compatible upstream -> 504 (upstream-adapters), malformed SSE frames
// (upstream-adapters), single-flight 40x and two-key non-coalescing
// (exact-cache), leader/waiter abort (single-flight-abort). What is added here:
//
//   * the REAL PgVectorStore against a throwing SqlClient (pgvector down on
//     read and on write) inside the running route;
//   * dead-Redis boundedness + a dead-Redis/dead-provider combination -> clean
//     502, never 500;
//   * provider timeout retry accounting and recovery after a timed-out attempt
//     (no stuck flight), plus connection-refused -> bounded 502;
//   * malformed provider JSON (clean 502, bounded retries) and an unshaped 200
//     body (documented empty-answer behaviour, observed gap, not a crash),
//     garbage/truncated SSE terminated cleanly with the app still serving;
//   * 256 KB body MISS->HIT and >1 MB body rejected as 413 with the OpenAI-style
//     envelope, provider never called, app healthy after;
//   * client abort of an in-flight non-stream request (bounded, one provider
//     call, no stuck in-flight state) and abort during retrying failures
//     (attempt count stays bounded, answer admitted exactly once);
//   * retry/fallback storm: one request -> <=3 attempts/target; three failures
//     open both breakers; a 10-request burst then completes with ZERO extra
//     provider calls and clean 502s;
//   * stampede under load: 100 identical requests -> 1 provider call,
//     5 distinct keys x 20 -> exactly 5 provider calls.
//
// Every test also asserts (afterEach) that no unhandled promise rejection
// escaped. Tests document the behaviour actually observed; none of them change
// src/ (a production bug would be reported to the Lead with a repro instead).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { PgVectorStore, type SqlClient } from "../../src/cache/PgVectorStore.js";
import { RedisCache } from "../../src/cache/RedisCache.js";
import { GatewayError } from "../../src/domain/types.js";
import { MockEmbedding } from "../../src/embeddings/MockEmbedding.js";
import { metrics } from "../../src/observability/metrics.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import { laneAuth } from "../helpers/lane.js";
import {
  abortable,
  chat,
  json,
  joinedDeltas,
  makeApp,
  parseSSE,
  ScriptedProvider,
  sendJson,
  sleep,
  startFakeUpstream,
} from "./harness.js";

const lanes = await laneAuth("mock");
const openaiLanes = await laneAuth("openai");
const LANE_KEY = lanes.laneFor("mock").key;
const OPENAI_KEY = openaiLanes.laneFor("openai").key;

const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "m",
  messages: [{ role: "user", content }],
  ...extra,
});

interface ChatPayload {
  choices: { message: { content: string } }[];
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Poll an observable side effect without relying on fixed sleeps. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function post(url: string, key: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function closeApp(app: FastifyInstance): Promise<void> {
  try {
    app.server.closeAllConnections();
    await app.close();
  } catch {
    /* already closed */
  }
}

/** Unhandled-rejection tripwire: a background flight must never escape. */
const rejections: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  rejections.push(reason);
};

beforeEach(() => {
  metrics.reset();
  rejections.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await sleep(25); // let any late background settlement surface
  process.off("unhandledRejection", onUnhandled);
  expect(rejections, "unhandled promise rejections escaped the gateway").toEqual([]);
});

// ---------------------------------------------------------------------------
// 1. pgvector / semantic store unavailable
// ---------------------------------------------------------------------------

class ThrowingSqlClient implements SqlClient {
  readonly queries: string[] = [];
  async query<T = Record<string, unknown>>(text: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push(text);
    throw new Error("connect ECONNREFUSED 127.0.0.1:5432 (pgvector unavailable)");
  }
  async close(): Promise<void> {
    /* no pool */
  }
}

class WriteFailingSqlClient implements SqlClient {
  readonly queries: string[] = [];
  async query<T = Record<string, unknown>>(text: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push(text);
    if (text.includes("INSERT INTO semantic_cache")) throw new Error("pgvector: semantic_cache is read-only");
    return { rows: [] };
  }
  async close(): Promise<void> {
    /* no pool */
  }
}

describe("vector store (pgvector) unavailable", () => {
  it("dead PgVectorStore: 200 MISS, semantic_errors counted, exact cache still serves, no 5xx", async () => {
    const sql = new ThrowingSqlClient();
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({
      auth: lanes.auth,
      provider,
      semanticStore: new PgVectorStore(sql),
      embedder: new MockEmbedding(),
    });

    const first = await chat(app, LANE_KEY, ask("pgvector down probe"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    const errorsAfterFirst = metrics.snapshot().semantic_errors;
    expect(errorsAfterFirst).toBeGreaterThan(0); // lookup and/or admission hit the dead store
    expect(sql.queries.length).toBeGreaterThan(0);

    // The dead semantic layer must not poison the exact cache: the admitted
    // answer is replayed without another provider call.
    const replay = await chat(app, LANE_KEY, ask("pgvector down probe"));
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(1);

    // A new cold request retries the dead store, degrades again, never 5xx.
    const cold = await chat(app, LANE_KEY, ask("pgvector down probe two"));
    expect(cold.statusCode).toBe(200);
    expect(cold.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    expect(metrics.snapshot().semantic_errors).toBeGreaterThan(errorsAfterFirst);
    expect([first, replay, cold].every((r) => r.statusCode < 500)).toBe(true);

    await closeApp(app);
  });

  it("pgvector read OK / write down: answer served and exact-cached, semantic_errors counted", async () => {
    const sql = new WriteFailingSqlClient();
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({
      auth: lanes.auth,
      provider,
      semanticStore: new PgVectorStore(sql),
      embedder: new MockEmbedding(),
    });

    const first = await chat(app, LANE_KEY, ask("pgvector write outage one"));
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(1);
    const errorsAfterFirst = metrics.snapshot().semantic_errors;
    expect(errorsAfterFirst).toBeGreaterThan(0); // the admission INSERT failed soft
    expect(sql.queries.some((q) => q.includes("INSERT INTO semantic_cache"))).toBe(true);

    const replay = await chat(app, LANE_KEY, ask("pgvector write outage one"));
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(provider.calls).toBe(1);

    const cold = await chat(app, LANE_KEY, ask("pgvector write outage two"));
    expect(cold.headers["x-cache"]).toBe("MISS");
    expect(provider.calls).toBe(2);
    expect(metrics.snapshot().semantic_errors).toBeGreaterThan(errorsAfterFirst);

    await closeApp(app);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 2. Redis / exact cache unavailable
// ---------------------------------------------------------------------------

describe("exact cache (Redis) unavailable", () => {
  it("dead Redis URL: MISS/200 with bounded latency, failure counters, no 5xx", async () => {
    const cache = new RedisCache({ url: "redis://127.0.0.1:1", commandTimeoutMs: 200 });
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, cache, env: { SEMANTIC_ENABLED: "false" } });
    const started = Date.now();
    try {
      const first = await chat(app, LANE_KEY, ask("redis down probe"));
      expect(first.statusCode).toBe(200);
      expect(first.headers["x-cache"]).toBe("MISS");
      expect(first.headers["x-cache-hash"]).toBeTruthy();

      const second = await chat(app, LANE_KEY, ask("redis down probe"));
      expect(second.statusCode).toBe(200);
      expect(second.headers["x-cache"]).toBe("MISS");
      expect(json<ChatPayload>(second).choices[0]!.message.content).toBe(json<ChatPayload>(first).choices[0]!.message.content);
      expect(provider.calls).toBe(2);

      // A dead cache may cost a command timeout per operation, but the request
      // must terminate well inside the test timeout and never hang.
      expect(Date.now() - started).toBeLessThan(5000);
      const m = metrics.snapshot();
      expect(m.cache_lookup_failed).toBeGreaterThanOrEqual(2);
      expect(m.cache_write_failed).toBeGreaterThanOrEqual(2);
      expect(m.provider_errors).toBe(0);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await closeApp(app);
      await cache.close();
    }
  }, 15000);

  it("dead Redis + failing provider: clean provider error, never a 500", async () => {
    const cache = new RedisCache({ url: "redis://127.0.0.1:1", commandTimeoutMs: 150 });
    const provider = new ScriptedProvider("mock", {
      chat: async () => {
        throw new GatewayError(502, "provider_error", "upstream down", false);
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider, cache, env: { SEMANTIC_ENABLED: "false" } });
    try {
      const res = await chat(app, LANE_KEY, ask("redis and provider down"));
      expect(res.statusCode).toBe(502);
      const body = json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe("provider_error");
      expect(res.body).not.toContain("ECONNREFUSED");
      expect(metrics.snapshot().cache_lookup_failed).toBeGreaterThan(0);
      expect(metrics.snapshot().provider_errors).toBe(1);
    } finally {
      await closeApp(app);
      await cache.close();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// 3. Provider timeout and connection refusal
// ---------------------------------------------------------------------------

function openAiApp(upstreamUrl: string, env: Record<string, string> = {}) {
  return makeApp({
    auth: openaiLanes.auth,
    provider: new OpenAICompatibleProvider({ name: "openai", baseURL: upstreamUrl, apiKey: "env-key", defaultModel: "gpt-default" }),
    env: { OPENAI_BASE_URL: upstreamUrl, OPENAI_API_KEY: "env-key", ...env },
  });
}

describe("provider timeout / connection refused", () => {
  it("upstream that never answers: gateway 504 inside the timeout bound, retries bounded", async () => {
    const upstream = await startFakeUpstream(() => {
      /* accept the request and never answer */
    });
    const { app } = openAiApp(upstream.url, { UPSTREAM_TIMEOUT_MS: "100" });
    const started = Date.now();
    try {
      const res = await chat(app, OPENAI_KEY, ask("hang please"));
      // The client-facing 504 fires when the route-level abort timer trips.
      expect(res.statusCode).toBe(504);
      expect(json<{ error: { code: string } }>(res).error.code).toBe("gateway_timeout");
      expect(Date.now() - started).toBeLessThan(1500);

      // A timeout aborts the shared upstream signal; executeChain refuses to
      // retry an aborted signal, so the attempt count is bounded at one (no
      // unbounded retry storm on a hung upstream). Wait for the background
      // flight to settle, then assert the accounting.
      await until(() => metrics.snapshot().provider_errors === 1, 5000);
      await until(() => upstream.hits.length === 1, 5000);
      const m = metrics.snapshot();
      expect(m.provider_requests).toBe(1);
      expect(m.provider_errors).toBe(1);
      expect(upstream.hits.length).toBe(1);

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await closeApp(app);
      await upstream.close();
    }
  }, 15000);

  it("after a timeout, a fresh request is served normally (no poisoned / stuck state)", async () => {
    const state = { calls: 0 };
    const provider = new ScriptedProvider("mock", {
      chat: async (req, signal) => {
        state.calls++;
        if (state.calls === 1) {
          await abortable(5000, signal); // aborted by the 100 ms upstream timeout
        }
        return { id: "recovered", model: req.model, content: "recovered after timeout", usage: { prompt_tokens: 2, completion_tokens: 2 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider, env: { UPSTREAM_TIMEOUT_MS: "100" } });
    const started = Date.now();
    try {
      const timedOut = await chat(app, LANE_KEY, ask("timeout then recover"));
      expect(timedOut.statusCode).toBe(504);
      expect(Date.now() - started).toBeLessThan(1500);

      // The failed flight is not cached and must not poison subsequent work:
      // a new request starts a fresh flight and is served.
      const second = await chat(app, LANE_KEY, ask("timeout then recover"));
      expect(second.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(state.calls).toBe(2); // one aborted attempt, then one fresh successful call
      expect(json<ChatPayload>(second).choices[0]!.message.content).toBe("recovered after timeout");

      const replay = await chat(app, LANE_KEY, ask("timeout then recover"));
      expect(replay.headers["x-cache"]).toBe("HIT");
      expect(state.calls).toBe(2);
    } finally {
      await closeApp(app);
    }
  }, 15000);

  it("connection refused: bounded clean 502 provider_error, no internals leak", async () => {
    // Port 1 on loopback refuses immediately (documented dead endpoint used by
    // the existing fallback suite as well).
    const { app } = makeApp({
      auth: openaiLanes.auth,
      provider: new OpenAICompatibleProvider({ name: "openai", baseURL: "http://127.0.0.1:1", apiKey: "env-key", defaultModel: "gpt-default" }),
      env: { OPENAI_BASE_URL: "http://127.0.0.1:1", OPENAI_API_KEY: "env-key", UPSTREAM_TIMEOUT_MS: "1500" },
    });
    const started = Date.now();
    try {
      const res = await chat(app, OPENAI_KEY, ask("refused please"));
      expect(res.statusCode).toBe(502);
      const body = json<{ error: { code: string; message: string; request_id: string } }>(res);
      expect(body.error.code).toBe("provider_error");
      expect(body.error.message).toContain("network error");
      expect(body.error.request_id).toBeTruthy();
      expect(res.body).not.toContain("    at "); // no stack trace
      expect(Date.now() - started).toBeLessThan(3000);

      expect(metrics.snapshot().provider_errors).toBe(1);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await closeApp(app);
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// 4. Malformed provider JSON / SSE
// ---------------------------------------------------------------------------

describe("malformed provider payloads", () => {
  it("invalid JSON body: clean 502, bounded retries, app keeps serving", async () => {
    const upstream = await startFakeUpstream((_hit, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"message":');
    });
    const { app } = openAiApp(upstream.url);
    try {
      const res = await chat(app, OPENAI_KEY, ask("malformed json"));
      expect(res.statusCode).toBe(502);
      expect(json<{ error: { code: string } }>(res).error.code).toBe("provider_error");
      expect(res.body).not.toContain("    at "); // no stack trace in the envelope
      expect(upstream.hits.length).toBe(3); // retryable network/parse error, bounded by maxRetries=2
      expect(metrics.snapshot().provider_errors).toBe(1);

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await closeApp(app);
      await upstream.close();
    }
  }, 15000);

  it("documented observation: a 200 with an unshaped choices field yields an empty, uncached 200", async () => {
    // Not a crash: the adapter's defensive `?? ""` returns an empty answer and
    // the gateway never admits blank content to the cache. It is reported as an
    // observed shape-handling gap (a malformed upstream 200 is not mapped to a
    // provider_error) rather than silently changed.
    const upstream = await startFakeUpstream((_hit, res) => {
      sendJson(res, 200, { id: "weird", model: "gpt-4o", choices: "not-an-array" });
    });
    const { app } = openAiApp(upstream.url);
    try {
      const first = await chat(app, OPENAI_KEY, ask("unshaped choices"));
      expect(first.statusCode).toBe(200);
      expect(json<ChatPayload>(first).choices[0]!.message.content).toBe("");
      expect(first.headers["x-cache"]).toBe("MISS");
      const second = await chat(app, OPENAI_KEY, ask("unshaped choices"));
      expect(second.statusCode).toBe(200);
      expect(second.headers["x-cache"]).toBe("MISS"); // blank answers are never admitted
      expect(upstream.hits.length).toBe(2);
    } finally {
      await closeApp(app);
      await upstream.close();
    }
  }, 15000);

  it("garbage/truncated SSE terminates cleanly and the app keeps streaming valid replies", async () => {
    let hits = 0;
    const upstream = await startFakeUpstream((_hit, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (hits === 1) {
        res.write("this is not an SSE frame at all\n\n");
        res.write('data: {"choices":[{"delta":{"content":"trunc'); // truncated mid-frame, then EOF
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ id: "ok", choices: [{ delta: { content: "hello" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    const { app } = openAiApp(upstream.url);
    try {
      const first = await chat(app, OPENAI_KEY, ask("garbage stream", { stream: true }));
      expect(first.statusCode).toBe(200);
      const parsed = parseSSE(first.body);
      expect(parsed.done).toBe(true);
      expect(parsed.frames.length).toBe(0); // nothing fabricated from garbage

      const second = await chat(app, OPENAI_KEY, ask("valid stream", { stream: true }));
      expect(second.statusCode).toBe(200);
      const parsedSecond = parseSSE(second.body);
      expect(parsedSecond.done).toBe(true);
      expect(joinedDeltas(parsedSecond.frames)).toBe("hello");
      expect(hits).toBe(2);

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await closeApp(app);
      await upstream.close();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// 5. Large request bodies
// ---------------------------------------------------------------------------

describe("large request bodies", () => {
  it("256 KB body: MISS then exact HIT, provider called once, hash stable", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider, env: { SEMANTIC_ENABLED: "false" } });
    try {
      const huge = `large payload ${"x".repeat(256 * 1024)}`;
      expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(256 * 1024);
      const miss = await chat(app, LANE_KEY, ask(huge));
      expect(miss.statusCode).toBe(200);
      expect(miss.headers["x-cache"]).toBe("MISS");
      const hit = await chat(app, LANE_KEY, ask(huge));
      expect(hit.statusCode).toBe(200);
      expect(hit.headers["x-cache"]).toBe("HIT");
      expect(hit.headers["x-cache-hash"]).toBe(miss.headers["x-cache-hash"]);
      expect(provider.calls).toBe(1);
    } finally {
      await closeApp(app);
    }
  }, 15000);

  it("over the 1 MB body limit: 413 payload_too_large, provider never called, app healthy", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    try {
      const oversized = `too large ${"y".repeat(1024 * 1024)}`; // JSON body > Fastify's 1 MB default
      const res = await chat(app, LANE_KEY, ask(oversized), { "x-request-id": "req-too-large" });
      expect(res.statusCode).toBe(413);
      const body = json<{ error: { code: string; request_id: string } }>(res);
      expect(body.error.code).toBe("payload_too_large");
      expect(body.error.request_id).toBe("req-too-large");
      expect(res.headers["x-request-id"]).toBe("req-too-large");
      expect(provider.calls).toBe(0);

      // The body limit must not wedge the app: the next normal request is served.
      const after = await chat(app, LANE_KEY, ask("small again"));
      expect(after.statusCode).toBe(200);
    } finally {
      await closeApp(app);
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// 6. Cancellation / abort cleanup
// ---------------------------------------------------------------------------

describe("cancel and abort cleanup", () => {
  it("client abort of an in-flight request: bounded, one provider call, no stuck state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const state = { entered: 0, calls: 0 };
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        state.entered++;
        state.calls++;
        await gate;
        return { id: "aborted-leader", model: req.model, content: "leader answer", usage: { prompt_tokens: 3, completion_tokens: 2 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const url = await listen(app);
    try {
      const ctrl = new AbortController();
      const started = Date.now();
      const pending = post(url, LANE_KEY, ask("abort cleanup"), ctrl.signal);
      await until(() => state.entered === 1);
      ctrl.abort();
      await expect(pending).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1500); // the HTTP surface terminates, it does not hang
      expect(state.calls).toBe(1); // abort does not spawn a retry

      release();
      const replay = await post(url, LANE_KEY, ask("abort cleanup"));
      expect(replay.status).toBe(200);
      const body = (await replay.json()) as ChatPayload;
      expect(body.choices[0]!.message.content).toBe("leader answer");

      await until(() => state.entered === 1);
      const replayAgain = await post(url, LANE_KEY, ask("abort cleanup"));
      expect(replayAgain.status).toBe(200);
      expect(replayAgain.headers.get("x-cache")).toBe("HIT"); // the background flight completed and cached
      expect(state.calls).toBe(1); // no extra provider calls after the abort

      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
    } finally {
      release();
      await closeApp(app);
    }
  }, 20000);

  it("abort during retrying failures: provider attempts stay bounded and the answer is admitted once", async () => {
    const state = { calls: 0 };
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        state.calls++;
        if (state.calls <= 2) throw new GatewayError(429, "provider_rate_limited", "mock rate limited.", true);
        return { id: "recovered-after-abort", model: req.model, content: "recovered answer", usage: { prompt_tokens: 2, completion_tokens: 2 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const url = await listen(app);
    try {
      const ctrl = new AbortController();
      const pending = post(url, LANE_KEY, ask("abort retry storm"), ctrl.signal);
      pending.catch(() => undefined);
      await until(() => state.calls === 1);
      ctrl.abort();
      await expect(pending).rejects.toThrow();

      // The shared flight that was already running keeps its own bounded
      // retries; a fresh identical request joins it and is served exactly once.
      const replay = await post(url, LANE_KEY, ask("abort retry storm"));
      expect(replay.status).toBe(200);
      const body = (await replay.json()) as ChatPayload;
      expect(body.choices[0]!.message.content).toBe("recovered answer");
      expect(state.calls).toBe(3); // two failures + the successful attempt, nothing more

      const replayAgain = await post(url, LANE_KEY, ask("abort retry storm"));
      expect(replayAgain.headers.get("x-cache")).toBe("HIT");
      expect(state.calls).toBe(3);
    } finally {
      await closeApp(app);
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// 7. Retry / fallback storms are bounded
// ---------------------------------------------------------------------------

function failing(name: string, status: number, retryable: boolean): ScriptedProvider {
  return new ScriptedProvider(name, {
    chat: async () => {
      throw new GatewayError(status, status === 429 ? "provider_rate_limited" : "provider_error", `${name} down`, retryable);
    },
  });
}

describe("retry and fallback storms", () => {
  it("one request against two failing targets: attempts capped at maxRetries+1 per target, clean 502", async () => {
    const primary = failing("mock", 503, true);
    const alt = failing("alt", 503, true);
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const started = Date.now();
    try {
      const res = await chat(app, LANE_KEY, ask("bounded storm"));
      // The chain surfaces the last target's error status (503); the important
      // part is that it is a clean provider_error envelope, not a 500.
      expect(res.statusCode).toBe(503);
      expect(json<{ error: { code: string } }>(res).error.code).toBe("provider_error");
      expect(primary.calls).toBe(3); // attempt 0,1,2 -> cap
      expect(alt.calls).toBe(3);
      expect(Date.now() - started).toBeLessThan(3000);
      const m = metrics.snapshot();
      expect(m.fallback_count).toBe(1);
      expect(m.provider_errors).toBe(1);
    } finally {
      await closeApp(app);
    }
  }, 20000);

  it("breaker opens after 3 failing requests; a 10-request burst then makes ZERO provider calls", async () => {
    const primary = failing("mock", 502, false);
    const alt = failing("alt", 502, false);
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await chat(app, LANE_KEY, ask(`open breakers ${i}`));
        expect(res.statusCode).toBe(502);
      }
      expect(primary.calls).toBe(3);
      expect(alt.calls).toBe(3);
      expect(metrics.snapshot().breaker_open).toBe(2); // one per target, counted once

      const callsBeforeBurst = { primary: primary.calls, alt: alt.calls };
      const started = Date.now();
      const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => chat(app, LANE_KEY, ask(`storm burst ${i}`))));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(burst.every((r) => r.statusCode === 502)).toBe(true);
      for (const res of burst) {
        const body = json<{ error: { code: string; message: string } }>(res);
        expect(body.error.code).toBe("provider_error");
        expect(body.error.message).toContain("all targets unavailable");
        expect(body.error.message).not.toContain("down");
      }
      // Circuit breakers short-circuit: the burst added not one upstream call.
      expect(primary.calls).toBe(callsBeforeBurst.primary);
      expect(alt.calls).toBe(callsBeforeBurst.alt);
      // Every exhausted flight counts one provider_error, including the
      // breaker-short-circuited burst (3 opening requests + 10 burst requests).
      expect(metrics.snapshot().provider_errors).toBe(3 + burst.length);

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await closeApp(app);
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// 8. Concurrent stampede under load
// ---------------------------------------------------------------------------

describe("concurrent stampede", () => {
  it("100 identical requests -> 1 provider call; 5 distinct keys x 20 -> exactly 5 calls", async () => {
    const state = { calls: 0 };
    const provider = new ScriptedProvider("mock", {
      chat: async (req) => {
        state.calls++;
        await sleep(30); // hold the flight open so followers can coalesce
        return { id: `sf-${state.calls}`, model: req.model, content: `answer: ${req.messages[0]!.content}`, usage: { prompt_tokens: 4, completion_tokens: 2 } };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider, env: { SEMANTIC_ENABLED: "false" } });
    try {
      // 100 concurrent requests for the SAME cold key.
      const identical = await Promise.all(Array.from({ length: 100 }, () => chat(app, LANE_KEY, ask("stampede identical"))));
      expect(identical.every((r) => r.statusCode === 200)).toBe(true);
      expect(state.calls).toBe(1);
      const m1 = metrics.snapshot();
      expect(m1.singleflight_leaders).toBe(1);
      expect(m1.provider_requests).toBe(1);
      const followers = identical.filter((r) => r.headers["x-coalesced"] === "true").length;
      const hits = identical.filter((r) => r.headers["x-cache"] === "HIT").length;
      expect(followers + hits).toBe(99);
      expect(new Set(identical.map((r) => json<ChatPayload>(r).choices[0]!.message.content)).size).toBe(1);

      const replay = await chat(app, LANE_KEY, ask("stampede identical"));
      expect(replay.headers["x-cache"]).toBe("HIT");
      expect(state.calls).toBe(1);

      // 5 distinct keys x 20 concurrent -> 5 provider calls, 95 coalesced followers.
      metrics.reset();
      const keys = ["alpha", "beta", "gamma", "delta", "epsilon"];
      const multi = await Promise.all(Array.from({ length: 100 }, (_, i) => chat(app, LANE_KEY, ask(`stampede multi ${keys[i % keys.length]}`))));
      expect(multi.every((r) => r.statusCode === 200)).toBe(true);
      expect(state.calls).toBe(6); // 1 (previous key) + 5 distinct keys
      const m2 = metrics.snapshot();
      expect(m2.singleflight_leaders).toBe(5);
      expect(m2.provider_requests).toBe(5);
      const followers2 = multi.filter((r) => r.headers["x-coalesced"] === "true").length;
      const hits2 = multi.filter((r) => r.headers["x-cache"] === "HIT").length;
      expect(followers2 + hits2).toBe(95);
    } finally {
      await closeApp(app);
    }
  }, 20000);
});

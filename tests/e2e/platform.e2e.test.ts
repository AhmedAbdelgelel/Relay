
import { beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { laneAuth } from "../helpers/lane.js";
import { abortable, chat, json, makeApp, parseSSE, ScriptedProvider, sleep, TEST_ENV, withEnv } from "./harness.js";

const lanes = await laneAuth("mock");
const VALID = { model: "m", messages: [{ role: "user", content: "platform probe" }] };

beforeEach(() => metrics.reset());

describe("health / providers / metrics", () => {
  it("/health reports the wired stack and tuning, with no secrets", async () => {
    const { app } = makeApp({ auth: lanes.auth, env: { OPENAI_API_KEY: "sk-live-secret" } });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = json<Record<string, unknown>>(res);
    expect(body["ok"]).toBe(true);
    expect(body["provider"]).toBe("mock");
    expect(typeof body["cache"]).toBe("string");
    expect(body["cache"]).not.toBe("none");
    expect(body["semantic"]).not.toBe("none");
    expect(body["embedder"]).not.toBe("none");
    expect(body["config"]).toMatchObject({
      cacheEnabled: true,
      cacheTtlSec: 3600,
      semanticEnabled: true,
      semanticThreshold: 0.92,
      semanticTopK: 3,
      semanticTtlSec: 3600,
      upstreamTimeoutMs: 2500,
    });
    expect(res.body).not.toContain("sk-live-secret");
    await app.close();
  });

  it("/providers reflects configured flags without ever echoing key values", async () => {
    const { app } = makeApp({
      auth: lanes.auth,
      providers: new Map([
        ["mock", new ScriptedProvider("mock")],
        ["openai", new ScriptedProvider("openai")],
      ]),
      env: { OPENAI_API_KEY: "sk-live-secret" },
    });
    const res = await app.inject({ method: "GET", url: "/providers" });
    expect(res.statusCode).toBe(200);
    const list = json<{ id: string; label: string; configured: boolean; active: boolean; endpoint: string }[]>(res);
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get("mock")).toMatchObject({ configured: true, active: true, endpoint: "in-process" });
    expect(byId.get("openai")).toMatchObject({ configured: true, active: false });
    expect(byId.get("anthropic")!.configured).toBe(false);
    expect(byId.get("gemini")!.configured).toBe(false);
        expect(byId.get("ollama")!.configured).toBe(false);
    expect(byId.get("openrouter")!.configured).toBe(false);
    expect(res.body).not.toContain("sk-live-secret");
    await app.close();
  });

  it("/metrics exposes the derived snapshot but never per-tenant data", async () => {
    const { app } = makeApp({ auth: lanes.auth });
    await chat(app, lanes.laneFor("mock").key, VALID);
    await chat(app, lanes.laneFor("mock").key, VALID);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = json<Record<string, unknown>>(res);
    for (const key of ["requests_total", "exact_hits", "exact_misses", "semantic_hits", "semantic_misses", "provider_requests", "hit_rate", "provider_calls_avoided", "semantic_lookups", "avg_semantic_score", "tokens_in", "tokens_out", "singleflight_leaders", "singleflight_coalesced", "auth_rejects_total", "fallback_count", "breaker_open"]) {
      expect(key in body).toBe(true);
    }
    expect(body["requests_total"]).toBe(2);
    expect(body["exact_hits"]).toBe(1);
    expect(res.body).not.toContain("tenants");
    expect(res.body).not.toContain(lanes.laneFor("mock").tenant);
    await app.close();
  });
});

describe("playground surface", () => {
  it("serves the control-plane statics with correct content types", async () => {
    const { app } = makeApp();
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(String(index.headers["content-type"])).toContain("text/html");
    expect(index.body).toContain("<html");

    const css = await app.inject({ method: "GET", url: "/styles.css" });
    expect(css.statusCode).toBe(200);
    expect(String(css.headers["content-type"])).toContain("text/css");

    const js = await app.inject({ method: "GET", url: "/js/app.js" });
    expect(js.statusCode).toBe(200);
    expect(String(js.headers["content-type"])).toContain("javascript");

    const missing = await app.inject({ method: "GET", url: "/js/nope.js" });
    expect(missing.statusCode).toBe(404);

    const traversal = await app.inject({ method: "GET", url: "/js/..%2F..%2F..%2Fpackage.json" });
    expect(traversal.statusCode).toBe(403);
    await app.close();
  });

  it("CORS covers exactly the API routes and preflight exposes the lane evidence", async () => {
    const { app } = makeApp({ auth: lanes.auth });
    const preflight = await app.inject({ method: "OPTIONS", url: "/v1/chat/completions", headers: { origin: "http://localhost:5173" } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(String(preflight.headers["access-control-allow-headers"])).toContain("x-provider-key");
    expect(String(preflight.headers["access-control-allow-headers"])).toContain("x-api-key");
    const expose = String(preflight.headers["access-control-expose-headers"]);
    expect(expose).toContain("x-lane");
    expect(expose).toContain("x-key-id");
    expect(expose).toContain("x-cache-hash");
    expect(expose).toContain("x-fallback");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["access-control-allow-origin"]).toBe("*");

    const usage = await app.inject({ method: "GET", url: "/v1/usage" });
    expect(usage.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("request validation", () => {
  it("every malformed body is 400 invalid_request: no lane, no provider, no counter", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const rejects: Record<string, unknown>[] = [
      { messages: VALID.messages },
      { model: "", messages: VALID.messages },
      { model: "m" },
      { model: "m", messages: [] },
      { model: "m", messages: "nope" },
      { model: "m", messages: [{ role: "tool", content: "x" }] },
      { model: "m", messages: [{ role: "user", content: "" }] },
      { model: "m", messages: [{ role: "user", content: 5 }] },
      { ...VALID, temperature: 2.5 },
      { ...VALID, temperature: -0.1 },
      { ...VALID, max_tokens: 0 },
      { ...VALID, max_tokens: 1.5 },
      { ...VALID, stream: "yes" },
    ];
    for (const payload of rejects) {
      const res = await chat(app, lanes.laneFor("mock").key, payload);
      expect(res.statusCode).toBe(400);
      const body = json<{ error: { code: string; request_id: string } }>(res);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.request_id).toBeTruthy();
      expect(res.headers["x-lane"]).toBeUndefined();
    }
    expect(provider.calls).toBe(0);
    expect(metrics.snapshot().requests_total).toBe(0);
    await app.close();
  });

  it("malformed JSON body is a standardized 400 with the echoed request id", async () => {
    const { app } = makeApp({ auth: lanes.auth });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${lanes.laneFor("mock").key}`,
        "content-type": "application/json",
        "x-request-id": "req-parse-1",
      },
      payload: '{"model": "m",',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["x-request-id"]).toBe("req-parse-1");
    const body = JSON.parse(res.body) as { error: { code: string; message: string; request_id: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.request_id).toBe("req-parse-1");
    expect(typeof body.error.message).toBe("string");
    await app.close();
  });

  it("client x-request-id is echoed on success and error; unknown routes are 404", async () => {
    const { app } = makeApp({ auth: lanes.auth });
    const ok = await chat(app, lanes.laneFor("mock").key, VALID, { "x-request-id": "req-echo-1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-request-id"]).toBe("req-echo-1");

    const bad = await chat(app, lanes.laneFor("mock").key, { model: "m" }, { "x-request-id": "req-echo-2" });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers["x-request-id"]).toBe("req-echo-2");
    expect(json<{ error: { request_id: string } }>(bad).error.request_id).toBe("req-echo-2");

    const notFound = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(notFound.statusCode).toBe(404);
    await app.close();
  });
});

describe("capability gate", () => {
  it("an undeclared capability is 400 unsupported_capability and the provider is never called", async () => {
    const cases: { caps: Record<string, boolean>; payload: Record<string, unknown>; missing: string }[] = [
      { caps: { streaming: false }, payload: { ...VALID, stream: true }, missing: "streaming" },
      { caps: { systemMessages: false }, payload: { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] }, missing: "systemMessages" },
      { caps: { maxTokens: false }, payload: { ...VALID, max_tokens: 5 }, missing: "maxTokens" },
    ];
    for (const c of cases) {
      const provider = new ScriptedProvider("mock", { capabilities: c.caps });
      const { app } = makeApp({ auth: lanes.auth, provider });
      const res = await chat(app, lanes.laneFor("mock").key, c.payload);
      expect(res.statusCode).toBe(400);
      const body = json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe("unsupported_capability");
      expect(body.error.message).toContain(c.missing);
      expect(provider.calls + provider.streamCalls).toBe(0);
      await app.close();
    }

    const provider = new ScriptedProvider("mock", { capabilities: { streaming: false, systemMessages: false, maxTokens: false } });
    const { app } = makeApp({ auth: lanes.auth, provider });
    const res = await chat(app, lanes.laneFor("mock").key, {
      model: "m",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      stream: true,
      max_tokens: 3,
    });
    expect(json<{ error: { message: string } }>(res).error.message).toContain("streaming, systemMessages, maxTokens");
    await app.close();
  });
});

describe("config boot invariants", () => {
  it("rejects unknown providers, bad stores and missing encryption keys", () => {
    expect(() => withEnv({ ...TEST_ENV, PROVIDER: "notaprovider" }, () => loadConfig())).toThrow(/PROVIDER must be one of/);
    expect(() => withEnv({ ...TEST_ENV, EMBEDDING_PROVIDER: "banana" }, () => loadConfig())).toThrow(/EMBEDDING_PROVIDER must be one of/);
    expect(() => withEnv({ ...TEST_ENV, SEMANTIC_STORE: "sqlite" }, () => loadConfig())).toThrow(/SEMANTIC_STORE must be one of/);
    expect(() => withEnv({ ...TEST_ENV, DATABASE_URL: "postgres://db", CRED_ENC_KEY: "" }, () => loadConfig())).toThrow(/CRED_ENC_KEY is required/);
    expect(() => withEnv({ ...TEST_ENV, GATEWAY_API_KEYS: "tenant:mock:name" }, () => loadConfig())).toThrow(/GATEWAY_API_KEYS/);
    expect(() => withEnv({ ...TEST_ENV, GATEWAY_API_KEYS: "tenant:nope:name:key" }, () => loadConfig())).toThrow(/provider must be one of/);
  });

  it("boolean parsing falls back safely on garbage", () => {
    const cfg = withEnv({ ...TEST_ENV, CACHE_ENABLED: "yes", SEMANTIC_ENABLED: "off" }, () => loadConfig());
    expect(cfg.cacheEnabled).toBe(true);
    expect(cfg.semanticEnabled).toBe(false);
  });

  it("explicitly set invalid numeric values throw at load instead of falling back", () => {
    expect(() => withEnv({ ...TEST_ENV, UPSTREAM_TIMEOUT_MS: "abc" }, () => loadConfig())).toThrow(
      /UPSTREAM_TIMEOUT_MS must be a positive number; got "abc"/,
    );
    expect(() => withEnv({ ...TEST_ENV, CACHE_TTL_S: "0" }, () => loadConfig())).toThrow(
      /CACHE_TTL_S must be a positive number; got "0"/,
    );
    expect(() => withEnv({ ...TEST_ENV, CACHE_TTL_S: "-5" }, () => loadConfig())).toThrow(/CACHE_TTL_S must be a positive number/);
    expect(() => withEnv({ ...TEST_ENV, SEMANTIC_TTL_S: "-1" }, () => loadConfig())).toThrow(/SEMANTIC_TTL_S must be a positive number/);
    expect(() => withEnv({ ...TEST_ENV, SEMANTIC_TOP_K: "zero" }, () => loadConfig())).toThrow(/SEMANTIC_TOP_K must be a positive number/);
    expect(() => withEnv({ ...TEST_ENV, SEMANTIC_THRESHOLD: "1" }, () => loadConfig())).toThrow(
      /SEMANTIC_THRESHOLD must be a number in \(0, 1\); got "1"/,
    );
    expect(() => withEnv({ ...TEST_ENV, SEMANTIC_THRESHOLD: "1.5" }, () => loadConfig())).toThrow(
      /SEMANTIC_THRESHOLD must be a number in \(0, 1\)/,
    );
    expect(() => withEnv({ ...TEST_ENV, SAVED_USD_PER_1K_TOKENS: "-3" }, () => loadConfig())).toThrow(
      /SAVED_USD_PER_1K_TOKENS must be a non-negative number; got "-3"/,
    );
  });

  it("valid numeric values pass through and unset numeric keys keep defaults", () => {
    const cfg = withEnv(
      {
        ...TEST_ENV,
        UPSTREAM_TIMEOUT_MS: "1500",
        CACHE_TTL_S: "60",
        SEMANTIC_THRESHOLD: "0.75",
        SEMANTIC_TOP_K: "5",
        SEMANTIC_TTL_S: "120",
        SAVED_USD_PER_1K_TOKENS: "0.25",
      },
      () => loadConfig(),
    );
    expect(cfg.upstreamTimeoutMs).toBe(1500);
    expect(cfg.cacheTtlSec).toBe(60);
    expect(cfg.semanticThreshold).toBe(0.75);
    expect(cfg.semanticTopK).toBe(5);
    expect(cfg.semanticTtlSec).toBe(120);
    expect(cfg.savedUsdPer1kTokens).toBe(0.25);
    const unset = withEnv(
      {
        ...TEST_ENV,
        UPSTREAM_TIMEOUT_MS: undefined,
        CACHE_TTL_S: undefined,
        SEMANTIC_THRESHOLD: undefined,
        SEMANTIC_TOP_K: undefined,
        SEMANTIC_TTL_S: undefined,
        SAVED_USD_PER_1K_TOKENS: undefined,
      },
      () => loadConfig(),
    );
    expect(unset.upstreamTimeoutMs).toBe(25000);
    expect(unset.cacheTtlSec).toBe(3600);
    expect(unset.semanticThreshold).toBe(0.95);
    expect(unset.semanticTopK).toBe(3);
    expect(unset.semanticTtlSec).toBe(3600);
    expect(unset.savedUsdPer1kTokens).toBe(0);
  });

  it("parses seeded gateway keys and keeps colons inside the key", () => {
    const cfg = withEnv(
      { ...TEST_ENV, GATEWAY_API_KEYS: "acme:openai:prod:sk-a:b,beta:mock:dev:lg_b" },
      () => loadConfig(),
    );
    expect(cfg.gatewayApiKeys).toEqual([
      { tenant: "acme", provider: "openai", name: "prod", key: "sk-a:b" },
      { tenant: "beta", provider: "mock", name: "dev", key: "lg_b" },
    ]);
  });
});

describe("real socket run", () => {
  it("serves over a real port: chat, SSE, and client-abort cancels the upstream", async () => {
    let aborted = false;
    const provider = new ScriptedProvider("mock", {
      stream: async function* (_req, signal) {
        yield { delta: "first" };
        try {
          await abortable(5000, signal);
        } catch (err) {
          aborted = true;
          throw err;
        }
        yield { delta: "never" };
      },
    });
    const { app } = makeApp({ auth: lanes.auth, provider });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const laneKey = lanes.laneFor("mock").key;

    const health = await fetch(`${address}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const chatRes = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${laneKey}` },
      body: JSON.stringify(VALID),
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get("x-cache")).toBe("MISS");

    const streamRes = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${laneKey}`, accept: "text/event-stream" },
      body: JSON.stringify({ ...VALID, stream: true }),
    });
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    reader.cancel().catch(() => undefined);
    await sleep(250);
    expect(aborted).toBe(true);

    const after = await fetch(`${address}/health`);
    expect(after.status).toBe(200);
    await app.close();
  });

  it("real SSE completes with [DONE] over the wire", async () => {
    const { app } = makeApp({ auth: lanes.auth });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${lanes.laneFor("mock").key}` },
      body: JSON.stringify({ ...VALID, stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const { done } = parseSSE(text);
    expect(done).toBe(true);
    await app.close();
  });
});


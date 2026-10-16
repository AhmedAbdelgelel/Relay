// tests/integration/two-lanes.test.ts — T26: the chat endpoint serves two lanes.
// REGISTERED (gateway key): the full pipeline — stored-credential upstream key,
// exact + semantic caches, per-tenant accounting. ANONYMOUS (x-provider-key
// only): a try-out — routed target only, caches bypassed, global counters only,
// nothing stored, and the env key can never serve or be a fallback for it.
//
// Pins the orchestrator rulings R1 (mismatch after routing), R2 (chains),
// R3 (credential resolution), R4 (providerWithKey), R5 (BYPASS + flight
// scoping), R6 (tenant accounting), R7 (x-tenant-id ignored), R8 (evidence
// headers through the wired route).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import type { SemanticCacheStore, SemanticEntry } from "../../src/cache/SemanticCacheStore.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";
import { createProvidersFromEnv, providerWithKey } from "../../src/providers/factory.js";
import { issueLane, laneAuth, TEST_TENANT } from "../helpers/lane.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: false, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "", savedUsdPer1kTokens: 0,
    ...over,
  };
}

function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

/** Test double: gateway-topic prompts share one vector, everything else orthogonal. */
class ParaphraseEmbedder implements EmbeddingProvider {
  readonly name = "test-paraphrase";
  readonly dimension = EMBEDDING_DIM;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    if (text.toLowerCase().includes("gateway")) return unit(0);
    return unit(1);
  }
}

function stub(name: string, counter: { calls: number }): ProviderAdapter {
  return {
    name,
    capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true },
    async chat(req, _signal) {
      counter.calls++;
      return { id: `${name}-1`, model: req.model, content: `${name} reply`, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
    async *chatStream(req, _signal) {
      counter.calls++;
      yield { delta: `${name} ` };
    },
  };
}

function countingProvider(inner: ProviderAdapter, counter: { calls: number }): ProviderAdapter {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    async chat(req, signal) {
      counter.calls++;
      return inner.chat(req, signal);
    },
    async *chatStream(req, signal) {
      counter.calls++;
      yield* inner.chatStream(req, signal);
    },
  };
}

function countingCache(inner: CacheRepository, counter: { sets: number; gets: number }): CacheRepository {
  return {
    name: inner.name,
    get: async (key) => {
      counter.gets++;
      return inner.get(key);
    },
    set: async (key, value, ttl) => {
      counter.sets++;
      return inner.set(key, value, ttl);
    },
    del: (key) => inner.del(key),
    ping: () => inner.ping(),
    close: () => inner.close(),
  };
}

/** Capture one JSON body per upstream fetch (for upstream-key assertions). */
function stubUpstream(seen: Array<Record<string, string>>) {
  vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: "openai says hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

beforeEach(() => metrics.reset());
afterEach(() => vi.unstubAllGlobals());

describe("T26 registered lane (full pipeline)", () => {
  it("MISS -> exact HIT with x-lane/x-key-id evidence and per-tenant usage", async () => {
    const app = Fastify();
    const calls = { calls: 0 };
    const lanes = await laneAuth("mock");
    registerChatRoutes(app, countingProvider(new MockProvider(), calls), cfg(), new InMemoryCache(), { auth: lanes.auth });
    const headers = lanes.headersFor("mock");
    const keyId = lanes.laneFor("mock").keyId;
    const payload = { model: "m", messages: [{ role: "user", content: "registered pipeline probe" }] };

    const miss = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload });
    expect(miss.statusCode).toBe(200);
    expect(miss.headers["x-cache"]).toBe("MISS");
    expect(miss.headers["x-lane"]).toBe("registered");
    expect(miss.headers["x-key-id"]).toBe(keyId);

    const hit = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.headers["x-lane"]).toBe("registered");
    expect(hit.headers["x-key-id"]).toBe(keyId);
    expect(calls.calls).toBe(1);

    const t = metrics.tenantSnapshot(TEST_TENANT);
    expect(t.requests).toBe(2);
    expect(t.exact_hits).toBe(1);
    expect(t.misses).toBe(1);
    expect(t.provider_calls_avoided).toBe(1);
    expect(t.avg_latency_ms).toBeGreaterThan(0);
    await app.close();
  });

  it("semantic path intact; tenant comes from the key — spoofed x-tenant-id is ignored", async () => {
    const app = Fastify();
    const inner = new InMemoryVectorStore();
    const saved: SemanticEntry[] = [];
    const spy: SemanticCacheStore = {
      name: inner.name,
      save: async (e) => {
        saved.push(e);
        return inner.save(e);
      },
      findSimilar: inner.findSimilar.bind(inner),
      recordHit: inner.recordHit.bind(inner),
      ping: inner.ping.bind(inner),
      close: inner.close.bind(inner),
    };
    const lanes = await laneAuth("mock");
    registerChatRoutes(app, new MockProvider(), cfg({ semanticEnabled: true }), new InMemoryCache(), {
      auth: lanes.auth,
      semanticStore: spy,
      embedder: new ParaphraseEmbedder(),
    });
    const base = lanes.headersFor("mock");

    const seed = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: { ...base, "x-tenant-id": "spoofed" }, // must have no effect
      payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] },
    });
    expect(seed.statusCode).toBe(200);
    expect(seed.headers["x-cache"]).toBe("MISS");

    const second = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: base,
      payload: { model: "m", messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] },
    });
    expect(second.headers["x-cache"]).toBe("SEMANTIC_HIT");

    // The entry was admitted under the KEY's tenant, never the header's.
    expect(saved.length).toBe(1);
    expect(saved[0]!.tenant).toBe(TEST_TENANT);
    expect(metrics.tenantSnapshot(TEST_TENANT).semantic_hits).toBe(1);
    // The spoofed identity got no accounting row and no cache entry.
    expect(metrics.tenantSnapshot("spoofed").requests).toBe(0);
    await app.close();
  });

  it("credential store outage degrades to the configured adapter, never 5xx (R3)", async () => {
    const lanes = await laneAuth("mock");
    const brokenCredentials: CredentialStore = {
      name: "broken",
      save: () => Promise.resolve({ status: "ok" }),
      get: () => Promise.resolve({ status: "unavailable", reason: "pool down" }),
      remove: () => Promise.resolve({ status: "not_found" }),
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg(), undefined, {
      auth: { apiKeys: lanes.auth.apiKeys, credentials: brokenCredentials },
    });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: lanes.headersFor("mock"),
      payload: { model: "m", messages: [{ role: "user", content: "cred outage probe" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("mock");
    await app.close();
  });
});

describe("T26 anonymous lane (try-out)", () => {
  it("BYPASS even with an identical exact-cache entry — provider called, nothing written, no tenant usage", async () => {
    const app = Fastify();
    const cacheCounter = { sets: 0, gets: 0 };
    const calls = { calls: 0 };
    const lanes = await laneAuth("mock");
    registerChatRoutes(app, countingProvider(new MockProvider(), calls), cfg(), countingCache(new InMemoryCache(), cacheCounter), {
      auth: lanes.auth,
    });
    const payload = { model: "m", messages: [{ role: "user", content: "anon bypass probe" }] };

    // Seed a real exact-cache entry through the registered lane.
    const seeded = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: lanes.headersFor("mock"), payload });
    expect(seeded.headers["x-cache"]).toBe("MISS");
    expect(calls.calls).toBe(1);
    const getsAfterSeed = cacheCounter.gets;
    const setsAfterSeed = cacheCounter.sets;

    // Identical anonymous request: the entry exists, but the lane never looks.
    const anon = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: { "x-provider-key": "sk-anon-tryout" },
      payload,
    });
    expect(anon.statusCode).toBe(200);
    expect(anon.headers["x-cache"]).toBe("BYPASS");
    expect(anon.headers["x-lane"]).toBe("anonymous");
    expect(anon.headers["x-key-id"]).toBeUndefined();
    // The anonymous chain is rebuilt via providerWithKey, so the wrapped
    // configured adapter never sees it — prove the fresh upstream call globally.
    expect(calls.calls).toBe(1); // only the registered seed used the configured adapter
    expect(metrics.snapshot().provider_requests).toBe(2); // anonymous called upstream too
    expect(cacheCounter.gets).toBe(getsAfterSeed); // not even a lookup
    expect(cacheCounter.sets).toBe(setsAfterSeed); // nothing admitted

    // Global counters count both lanes; tenant accounting only the registered one.
    expect(metrics.snapshot().requests_total).toBe(2);
    expect(metrics.tenantSnapshot(TEST_TENANT).requests).toBe(1);
    await app.close();
  });

  it("semantic store is never read or written", async () => {
    const app = Fastify();
    const inner = new InMemoryVectorStore();
    const counters = { saves: 0, finds: 0 };
    const spy: SemanticCacheStore = {
      name: inner.name,
      save: async (e) => {
        counters.saves++;
        return inner.save(e);
      },
      findSimilar: async (e, f, o) => {
        counters.finds++;
        return inner.findSimilar(e, f, o);
      },
      recordHit: inner.recordHit.bind(inner),
      ping: inner.ping.bind(inner),
      close: inner.close.bind(inner),
    };
    const lanes = await laneAuth("mock");
    registerChatRoutes(app, new MockProvider(), cfg({ semanticEnabled: true }), new InMemoryCache(), {
      auth: lanes.auth,
      semanticStore: spy,
      embedder: new ParaphraseEmbedder(),
    });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: { "x-provider-key": "sk-anon-semantic" },
      payload: { model: "m", messages: [{ role: "user", content: "anonymous gateway probe" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(counters.finds).toBe(0);
    expect(counters.saves).toBe(0);
    await app.close();
  });

  it("upstream key resolution: anonymous sends the presented key; registered sends the env key, then the stored credential (R3/R4)", async () => {
    const seen: Array<Record<string, string>> = [];
    stubUpstream(seen);
    const c = cfg({ openaiApiKey: "sk-env-key" });
    const providers = createProvidersFromEnv(c);
    const lanes = await laneAuth("openai");
    const app = Fastify();
    registerChatRoutes(app, providers.get("mock")!, c, undefined, { auth: lanes.auth, providers });
    const payload = { model: "gpt-4o-mini", messages: [{ role: "user", content: "key resolution probe" }] };

    // 1) Anonymous: the routed target is rebuilt from the header key ONLY —
    // the env-keyed adapter in the map is unreachable for this lane.
    const anon = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-provider-key": "sk-anon-header" }, payload });
    expect(anon.statusCode).toBe(200);
    expect(seen[0]!["Authorization"]).toBe("Bearer sk-anon-header");

    // 2) Registered, no stored credential: the configured (env-keyed) adapter serves.
    const reg = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: lanes.headersFor("openai"), payload });
    expect(reg.statusCode).toBe(200);
    expect(seen[1]!["Authorization"]).toBe("Bearer sk-env-key");

    // 3) Registered with a stored credential: the tenant key is used, not the env key.
    const put = await lanes.auth.credentials.save(TEST_TENANT, "openai", "sk-tenant-stored");
    expect(put.status).toBe("ok");
    const cred = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: lanes.headersFor("openai"), payload });
    expect(cred.statusCode).toBe(200);
    expect(seen[2]!["Authorization"]).toBe("Bearer sk-tenant-stored");
    await app.close();
  });

  it("single-flight scoping: anonymous flights are per presented key and never join a registered flight (R5)", async () => {
    // A slow upstream makes coalescing observable: every fetch is one real
    // upstream execution. Both lanes route to "openai" (gpt-* model), and the
    // anonymous lane rebuilds its adapter from the presented key.
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      await new Promise<void>((r) => setTimeout(r, 150));
      return new Response(
        JSON.stringify({
          id: "chatcmpl-x",
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "openai says hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const c = cfg({ openaiApiKey: "sk-env-key" });
    const providers = createProvidersFromEnv(c);
    const lanes = await laneAuth("openai");
    const app = Fastify();
    registerChatRoutes(app, providers.get("mock")!, c, undefined, { auth: lanes.auth, providers });
    const payload = { model: "gpt-4o-mini", messages: [{ role: "user", content: "flight scope probe" }] };

    const [reg, anon] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/chat/completions", headers: lanes.headersFor("openai"), payload }),
      app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-provider-key": "sk-anon-flight" }, payload }),
    ]);
    expect(reg.statusCode).toBe(200);
    expect(anon.statusCode).toBe(200);
    expect(anon.headers["x-cache"]).toBe("BYPASS");
    expect(fetches).toBe(2); // no upstream work is shared across lanes

    const [a1, a2] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-provider-key": "sk-key-one" }, payload }),
      app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-provider-key": "sk-key-two" }, payload }),
    ]);
    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(200);
    expect(fetches).toBe(4); // different presented keys = different flights
    await app.close();
  });

  it("anonymous failure never falls over to env-keyed adapters in the map (R2)", async () => {
    const auths: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      auths.push(String(init?.headers?.["Authorization"] ?? ""));
      return new Response("busy", { status: 429 });
    });
    const c = cfg({ openaiApiKey: "sk-env-key" });
    const providers = createProvidersFromEnv(c);
    const lanes = await laneAuth("openai");
    const app = Fastify();
    registerChatRoutes(app, providers.get("mock")!, c, undefined, { auth: lanes.auth, providers });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: { "x-provider-key": "sk-anon-fail" },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "anon failure probe" }] },
    });
    expect(res.statusCode).toBe(429);
    // Every upstream attempt (incl. bounded retries) went out with the
    // presented key; the env-keyed map adapter never served or failed over.
    expect(auths.length).toBeGreaterThanOrEqual(1);
    expect(auths.every((a) => a === "Bearer sk-anon-fail")).toBe(true);
    expect(res.headers["x-fallback"]).toBeUndefined();
    expect(metrics.snapshot().fallback_count).toBe(0);
    await app.close();
  });
});

describe("T26 auth failures through the wired route", () => {
  it("no key at all: 401 missing_api_key with register hint, before validation/provider/cache", async () => {
    const app = Fastify();
    const calls = { calls: 0 };
    const cacheCounter = { sets: 0, gets: 0 };
    const lanes = await laneAuth("mock");
    registerChatRoutes(app, countingProvider(new MockProvider(), calls), cfg(), countingCache(new InMemoryCache(), cacheCounter), {
      auth: lanes.auth,
    });

    // Deliberately INVALID body: the guard must run before validation.
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "", messages: [] } });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("missing_api_key");
    expect(body.error.message).toContain("/v1/register");
    expect(body.error.request_id).toBeTruthy();
    expect(res.headers["x-lane"]).toBeUndefined();
    expect(calls.calls).toBe(0);
    expect(cacheCounter.gets).toBe(0);
    expect(cacheCounter.sets).toBe(0);

    // Valid body, still no key -> same 401, still nothing spent.
    const res2 = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "hi" }] } });
    expect(res2.statusCode).toBe(401);
    expect(res2.json().error.code).toBe("missing_api_key");
    expect(calls.calls).toBe(0);
    await app.close();
  });

  it("key bound to another provider: 403 provider_mismatch after routing, nothing spent (R1)", async () => {
    const app = Fastify();
    const calls = { calls: 0 };
    const cacheCounter = { sets: 0, gets: 0 };
    const lanes = await laneAuth("mock");
    const providers = new Map<string, ProviderAdapter>([["openai", stub("openai", calls)]]);
    registerChatRoutes(app, providers.get("openai")!, cfg(), countingCache(new InMemoryCache(), cacheCounter), {
      auth: lanes.auth,
      providers,
    });
    // Model routes to "openai" (gpt-*), but the key is bound to "mock".
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: lanes.headersFor("mock"),
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "mismatch probe" }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("provider_mismatch");
    // Evidence headers are set right after validation, so the 403 carries them.
    expect(res.headers["x-lane"]).toBe("registered");
    expect(res.headers["x-key-id"]).toBe(lanes.laneFor("mock").keyId);
    expect(calls.calls).toBe(0);
    expect(cacheCounter.gets).toBe(0);
    // T27/R1: the wired mismatch counts with the guard's other auth rejections.
    expect(metrics.snapshot().auth_rejects_total).toBe(1);
    await app.close();
  });

  it("revoked and expired keys stay 403 through the wired route", async () => {
    const app = Fastify();
    const lanes = await laneAuth("mock");
    registerChatRoutes(app, new MockProvider(), cfg(), undefined, { auth: lanes.auth });

    const doomed = await issueLane(lanes.auth, "mock", "t-revoked");
    await lanes.auth.apiKeys.revoke(doomed.keyId);
    const revoked = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: doomed.headers,
      payload: { model: "m", messages: [{ role: "user", content: "revoked probe" }] },
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().error.code).toBe("key_revoked");
    expect(revoked.headers["x-lane"]).toBeUndefined();

    const created = await lanes.auth.apiKeys.create({
      tenant: "t-expired",
      provider: "mock",
      name: "expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    if (created.status !== "created") throw new Error("expired lane issue failed");
    const expired = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${created.issued.key}` },
      payload: { model: "m", messages: [{ role: "user", content: "expired probe" }] },
    });
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error.code).toBe("key_expired");
    await app.close();
  });
});

describe("T26 evidence headers on every validated reply (R8)", () => {
  it("provider error (429) and stream (SSE) replies both carry x-lane + x-key-id", async () => {
    const app = Fastify();
    const lanes = await laneAuth("mock");
    const keyId = lanes.laneFor("mock").keyId;
    registerChatRoutes(app, new MockProvider({ failure: "rate_limited" }), cfg(), undefined, { auth: lanes.auth });

    const err = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: lanes.headersFor("mock"),
      payload: { model: "m", messages: [{ role: "user", content: "evidence err probe" }] },
    });
    expect(err.statusCode).toBe(429);
    expect(err.headers["x-lane"]).toBe("registered");
    expect(err.headers["x-key-id"]).toBe(keyId);

    const app2 = Fastify();
    registerChatRoutes(app2, new MockProvider(), cfg(), undefined, { auth: lanes.auth });
    const s = await app2.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: lanes.headersFor("mock"),
      payload: { model: "m", messages: [{ role: "user", content: "evidence stream probe" }], stream: true },
    });
    expect(s.statusCode).toBe(200);
    expect(s.headers["x-lane"]).toBe("registered");
    expect(s.headers["x-key-id"]).toBe(keyId);
    expect(s.headers["x-cache"]).toBe("BYPASS");
    await app2.close();
    await app.close();
  });

  it("providerWithKey mirrors env constructor names and rejects unknown names (R4)", () => {
    const c = cfg();
    for (const name of ["mock", "gemini", "ollama", "openai", "anthropic", "openrouter"]) {
      expect(providerWithKey(name, "sk-x", c).name).toBe(name);
    }
    expect(() => providerWithKey("not-a-provider", "sk-x", c)).toThrow(/unknown provider/);
  });
});

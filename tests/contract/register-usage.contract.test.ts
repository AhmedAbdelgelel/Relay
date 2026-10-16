// Contract tests for T27: POST /v1/register (open) and GET /v1/usage
// (gateway key) — plus the auth_rejects_total counter (R1).
//
// The app here wires the real trio — register + usage + chat over one memory
// auth pair — so register→chat→usage runs end-to-end through the same routes
// server.ts registers. Rulings exercised: R1 (counter), R2 (register flow and
// exact 201 body), R3 (usage = caller's tenantSnapshot only), R4 (provider
// list from config.PROVIDER_NAMES). Key-material contract: no provider_key or
// issued key ever appears in a response, the logs, metrics, or usage bodies.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { registerRegisterRoutes } from "../../src/api/routes/register.js";
import { registerUsageRoutes } from "../../src/api/routes/usage.js";
import type { ApiKeyStore, IssuedApiKey } from "../../src/auth/ApiKeyStore.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

const TEST_CRED_SECRET = "t27-test-credential-secret";

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

function freshAuth() {
  return {
    apiKeys: new InMemoryApiKeyStore(),
    credentials: new InMemoryCredentialStore(new CredentialCipher(TEST_CRED_SECRET)),
  };
}

/** register + usage + chat on one app, mirroring server.ts wiring. */
function buildApp(auth = freshAuth()) {
  const app = Fastify();
  registerChatRoutes(app, new MockProvider({ delayMs: 5 }), cfg(), new InMemoryCache(), { auth });
  registerRegisterRoutes(app, auth);
  registerUsageRoutes(app, auth);
  return { app, auth };
}

interface RegisterBody {
  tenant_id: string;
  provider: string;
  key: string;
  key_prefix: string;
}

async function registerOk(app: FastifyInstance, payload: { name: string; provider: string; provider_key: string }) {
  const res = await app.inject({ method: "POST", url: "/v1/register", payload });
  expect(res.statusCode).toBe(201);
  return { res, body: res.json() as RegisterBody };
}

const chat = (app: FastifyInstance, key: string, content: string) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}` },
    payload: { model: "m", messages: [{ role: "user", content }] },
  });

const usageOf = (app: FastifyInstance, key: string) =>
  app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key}` } });

async function issueKey(store: ApiKeyStore, tenant: string, provider: string, expiresAt?: string): Promise<IssuedApiKey> {
  const res = await store.create({ tenant, provider, name: "t27-key", expiresAt });
  if (res.status !== "created") throw new Error(`key issue failed: ${res.status}`);
  return res.issued;
}

beforeEach(() => metrics.reset());

describe("POST /v1/register (T27/R2)", () => {
  it("201: exact body shape, lg_ key returned once, key_prefix matches, provider_key never echoed or logged", async () => {
    const { app, auth } = buildApp();
    const providerKey = "sk-upstream-secret-A";
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/register",
        headers: { "x-request-id": "req-reg-1" },
        payload: { name: "prod", provider: "mock", provider_key: providerKey },
      });
      const logged = logs.mock.calls.map((c) => c.join(" ")).join("\n");

      expect(res.statusCode).toBe(201);
      expect(res.headers["x-request-id"]).toBe("req-reg-1");
      const body = res.json() as RegisterBody;

      // 201 body is EXACTLY these four fields, and no provider_key echo.
      expect(Object.keys(body).sort()).toEqual(["key", "key_prefix", "provider", "tenant_id"]);
      expect(body.provider).toBe("mock");
      expect(body.tenant_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.key.startsWith("lg_")).toBe(true);
      expect(body.key_prefix).toBe(body.key.slice(0, 8));
      expect(res.body).not.toContain(providerKey);

      // The key is shown once: it verifies, and list() exposes metadata only.
      const verified = await auth.apiKeys.verify(body.key);
      expect(verified.status).toBe("valid");
      const listed = await auth.apiKeys.list(body.tenant_id);
      if (listed.status !== "ok") throw new Error("list failed");
      expect(listed.keys.length).toBe(1);
      const rec = listed.keys[0]!;
      expect(rec.keyPrefix).toBe(body.key_prefix);
      expect(Object.keys(rec).sort()).toEqual(
        ["createdAt", "expiresAt", "id", "keyPrefix", "name", "provider", "revokedAt", "tenant"],
      );
      expect(JSON.stringify(listed)).not.toContain(body.key);

      // The provider key round-trips (encrypted at rest) but never reaches logs.
      const cred = await auth.credentials.get(body.tenant_id, "mock");
      expect(cred).toEqual({ status: "ok", providerKey });
      expect(logged).not.toContain(providerKey);
      expect(logged).not.toContain(body.key);
      expect(logged).toContain(body.key_prefix);
      expect(logged).toContain(body.tenant_id);
    } finally {
      logs.mockRestore();
    }
    await app.close();
  });

  it("400 invalid_request on missing, empty, or unknown fields; no store is touched and no auth rejection counted", async () => {
    let saves = 0;
    let creates = 0;
    const credentials: CredentialStore = {
      name: "spy",
      save: () => {
        saves += 1;
        return Promise.resolve({ status: "ok" });
      },
      get: () => Promise.resolve({ status: "not_found" }),
      remove: () => Promise.resolve({ status: "not_found" }),
      close: () => Promise.resolve(),
    };
    const apiKeys: ApiKeyStore = {
      name: "spy",
      verify: () => Promise.resolve({ status: "invalid" }),
      create: () => {
        creates += 1;
        return Promise.resolve({ status: "unavailable", reason: "spy: create must not run" });
      },
      list: () => Promise.resolve({ status: "ok", keys: [] }),
      revoke: () => Promise.resolve({ status: "not_found" }),
      rotate: () => Promise.resolve({ status: "not_found" }),
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerRegisterRoutes(app, { apiKeys, credentials });

    const cases: Array<Record<string, unknown>> = [
      {}, // everything missing
      { name: "x", provider: "mock" }, // provider_key missing
      { name: "x", provider_key: "sk-secret-400" }, // provider missing
      { provider: "mock", provider_key: "sk-secret-400" }, // name missing
      { name: "", provider: "mock", provider_key: "sk-secret-400" }, // empty name
      { name: "x", provider: "", provider_key: "sk-secret-400" }, // empty provider
      { name: "x", provider: "mock", provider_key: "" }, // empty provider_key
      { name: "x", provider: "not-a-provider", provider_key: "sk-secret-400" }, // unknown provider
      { name: "x", provider: "OpenAI", provider_key: "sk-secret-400" }, // provider is case-sensitive
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: "POST", url: "/v1/register", headers: { "x-request-id": "req-400" }, payload });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.request_id).toBe("req-400");
      expect(res.headers["x-request-id"]).toBe("req-400");
      expect(Object.keys(body.error).sort()).toEqual(["code", "message", "request_id"]);
      expect(res.body).not.toContain("sk-secret-400"); // no provider_key echo in any 400
    }
    expect(saves).toBe(0);
    expect(creates).toBe(0);
    // Register failures are not auth rejections (R1): no identity was presented.
    expect(metrics.snapshot().auth_rejects_total).toBe(0);
    await app.close();
  });

  it("503 auth_unavailable when the credential store is down — before any key is minted", async () => {
    const apiKeys = new InMemoryApiKeyStore();
    const credentials: CredentialStore = {
      name: "down",
      save: () => Promise.resolve({ status: "unavailable", reason: "connect ECONNREFUSED 127.0.0.1:5432" }),
      get: () => Promise.resolve({ status: "unavailable" }),
      remove: () => Promise.resolve({ status: "unavailable" }),
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerRegisterRoutes(app, { apiKeys, credentials });

    const res = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: { name: "x", provider: "mock", provider_key: "sk-should-not-echo" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_unavailable");
    expect(Object.keys(res.json().error).sort()).toEqual(["code", "message", "request_id"]);
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("sk-should-not-echo");
    const listed = await apiKeys.list();
    if (listed.status !== "ok") throw new Error("list failed");
    expect(listed.keys.length).toBe(0);
    expect(metrics.snapshot().auth_rejects_total).toBe(0);
    await app.close();
  });

  it("503 auth_unavailable when the key store is down; the credential write completes (documented orphan)", async () => {
    const inner = new InMemoryCredentialStore(new CredentialCipher(TEST_CRED_SECRET));
    const tenantSeen: string[] = [];
    const credentials: CredentialStore = {
      name: inner.name,
      save: (tenant, provider, providerKey) => {
        tenantSeen.push(tenant);
        return inner.save(tenant, provider, providerKey);
      },
      get: inner.get.bind(inner),
      remove: inner.remove.bind(inner),
      close: inner.close.bind(inner),
    };
    const apiKeys: ApiKeyStore = {
      name: "down",
      verify: () => Promise.resolve({ status: "unavailable" }),
      create: () => Promise.resolve({ status: "unavailable", reason: "pg unreachable" }),
      list: () => Promise.resolve({ status: "unavailable" }),
      revoke: () => Promise.resolve({ status: "unavailable" }),
      rotate: () => Promise.resolve({ status: "unavailable" }),
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerRegisterRoutes(app, { apiKeys, credentials });

    const res = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: { name: "x", provider: "mock", provider_key: "sk-orphan" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_unavailable");
    expect(res.body).not.toContain("pg unreachable");
    // Orphan: the (encrypted) credential exists, no key was issued, and the
    // tenant id was never disclosed — a retry simply mints a fresh tenant.
    expect(tenantSeen.length).toBe(1);
    const got = await credentials.get(tenantSeen[0]!, "mock");
    expect(got).toEqual({ status: "ok", providerKey: "sk-orphan" });
    await app.close();
  });
});

describe("GET /v1/usage (T27/R3)", () => {
  it("register -> chat (miss + exact hit) -> usage: the issued key works end-to-end; usage shows the caller's numbers", async () => {
    const { app } = buildApp();
    const { body } = await registerOk(app, { name: "alice", provider: "mock", provider_key: "sk-alice" });

    const miss = await chat(app, body.key, "hello alice");
    expect(miss.statusCode).toBe(200);
    expect(miss.headers["x-lane"]).toBe("registered");
    expect(miss.headers["x-provider"]).toBe("mock");
    expect(miss.headers["x-cache"]).toBe("MISS");
    expect(miss.headers["x-key-id"]).toBeTruthy();
    expect(miss.headers["x-key-id"]).not.toBe(body.key);

    const hit = await chat(app, body.key, "hello alice");
    expect(hit.statusCode).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");

    const usage = await usageOf(app, body.key);
    expect(usage.statusCode).toBe(200);
    const u = usage.json();
    expect(Object.keys(u).sort()).toEqual([
      "avg_latency_ms", "coalesced", "exact_hits", "hit_rate", "latency_ms_total",
      "misses", "provider_calls_avoided", "requests", "semantic_hits", "tenant",
    ]);
    expect(u.tenant).toBe(body.tenant_id);
    expect(u.requests).toBe(2);
    expect(u.exact_hits).toBe(1);
    expect(u.semantic_hits).toBe(0);
    expect(u.misses).toBe(1);
    expect(u.coalesced).toBe(0);
    expect(u.hit_rate).toBe(0.5);
    expect(u.provider_calls_avoided).toBe(1);
    expect(u.avg_latency_ms).toBeGreaterThan(0);
    expect(u.latency_ms_total).toBeGreaterThan(0);

    // No key material on any read surface: usage, /metrics, chat evidence.
    expect(usage.body).not.toContain(body.key);
    expect(usage.body).not.toContain("lg_");
    const metricsRes = await app.inject({ method: "GET", url: "/metrics" });
    expect(metricsRes.body).not.toContain(body.key);
    expect(metricsRes.body).not.toContain("sk-alice");
    expect(metricsRes.json().auth_rejects_total).toBe(0);
    // Successful lanes never count as auth rejections.
    expect(metrics.snapshot().auth_rejects_total).toBe(0);
    await app.close();
  });

  it("returns only the caller's slice — a second tenant's traffic never leaks into it", async () => {
    const { app } = buildApp();
    const a = (await registerOk(app, { name: "alice", provider: "mock", provider_key: "sk-a" })).body;
    const b = (await registerOk(app, { name: "bob", provider: "mock", provider_key: "sk-b" })).body;
    expect(a.tenant_id).not.toBe(b.tenant_id);

    await chat(app, a.key, "alice prompt"); // tenant A: miss
    await chat(app, a.key, "alice prompt"); // tenant A: exact hit
    await chat(app, b.key, "bob prompt"); // tenant B: a different prompt -> its own miss

    const ua = (await usageOf(app, a.key)).json();
    expect(ua.tenant).toBe(a.tenant_id);
    expect(ua.requests).toBe(2);
    expect(ua.exact_hits).toBe(1);
    expect(ua.misses).toBe(1);
    expect(ua.hit_rate).toBe(0.5);
    expect(ua.provider_calls_avoided).toBe(1);

    const ub = (await usageOf(app, b.key)).json();
    expect(ub.tenant).toBe(b.tenant_id);
    expect(ub.requests).toBe(1);
    expect(ub.exact_hits).toBe(0);
    expect(ub.semantic_hits).toBe(0);
    expect(ub.misses).toBe(1);
    expect(ub.hit_rate).toBe(0);
    expect(ub.provider_calls_avoided).toBe(0);

    // Each body carries only its own tenant id; the globals still see all 3 requests.
    expect(JSON.stringify(ua)).not.toContain(b.tenant_id);
    expect(JSON.stringify(ub)).not.toContain(a.tenant_id);
    expect(metrics.snapshot().requests_total).toBe(3);
    await app.close();
  });

  it("401 matrix: no key, anonymous try-out, and invalid key — each counted once (R1)", async () => {
    const { app } = buildApp();

    const none = await app.inject({ method: "GET", url: "/v1/usage" });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe("missing_api_key");
    expect(none.json().error.message).toContain("POST /v1/register");

    const anon = await app.inject({ method: "GET", url: "/v1/usage", headers: { "x-provider-key": "sk-tryout-9" } });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe("missing_api_key");
    expect(anon.json().error.message).toContain("Bearer");
    expect(anon.body).not.toContain("sk-tryout-9");

    const bad = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: "Bearer lg_bogus" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("invalid_api_key");
    expect(bad.body).not.toContain("lg_bogus");

    expect(metrics.snapshot().auth_rejects_total).toBe(3);
    await app.close();
  });

  it("403 revoked, 403 expired, and 503 store down — each counted, no key material echoed", async () => {
    const { app, auth } = buildApp();

    const revoked = await issueKey(auth.apiKeys, "t27-revoked", "mock");
    await auth.apiKeys.revoke(revoked.record.id);
    const revokedRes = await usageOf(app, revoked.key);
    expect(revokedRes.statusCode).toBe(403);
    expect(revokedRes.json().error.code).toBe("key_revoked");
    expect(revokedRes.body).not.toContain(revoked.key);

    const expired = await issueKey(auth.apiKeys, "t27-expired", "mock", new Date(Date.now() - 60_000).toISOString());
    const expiredRes = await usageOf(app, expired.key);
    expect(expiredRes.statusCode).toBe(403);
    expect(expiredRes.json().error.code).toBe("key_expired");
    expect(expiredRes.body).not.toContain(expired.key);

    const downKeys: ApiKeyStore = {
      name: "down",
      verify: () => Promise.resolve({ status: "unavailable", reason: "pg pool down" }),
      create: () => Promise.resolve({ status: "unavailable" }),
      list: () => Promise.resolve({ status: "unavailable" }),
      revoke: () => Promise.resolve({ status: "unavailable" }),
      rotate: () => Promise.resolve({ status: "unavailable" }),
      close: () => Promise.resolve(),
    };
    const downApp = Fastify();
    registerUsageRoutes(downApp, { apiKeys: downKeys });
    const down = await downApp.inject({ method: "GET", url: "/v1/usage", headers: { authorization: "Bearer lg_whatever" } });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("auth_unavailable");
    expect(down.body).not.toContain("pg pool down");
    expect(down.body).not.toContain("lg_whatever");

    expect(metrics.snapshot().auth_rejects_total).toBe(3);
    await downApp.close();
    await app.close();
  });
});

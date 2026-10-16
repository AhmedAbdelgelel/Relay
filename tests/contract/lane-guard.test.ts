// Contract tests for the T25 lane guard: the full lane matrix through a
// minimal Fastify app (app.inject), the auth error vocabulary, header
// precedence, provider mismatch, and the guarantee that rejected requests
// never reach downstream work (the route handler stands in for
// validation/provider/cache here — T26 wires the real chat route).

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ApiKeyStore, CreateApiKeyResult } from "../../src/auth/ApiKeyStore.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { createLaneGuard, laneProviderMismatch, type LaneAuth } from "../../src/auth/laneGuard.js";
import { GatewayError } from "../../src/domain/types.js";
import { loadConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";

function seededStore(entries: string): InMemoryApiKeyStore {
  const cfg = loadConfig({ PROVIDER: "mock", GATEWAY_API_KEYS: entries } as NodeJS.ProcessEnv);
  return new InMemoryApiKeyStore(cfg.gatewayApiKeys);
}

function fakeStore(impl: ApiKeyStore["verify"]): ApiKeyStore & { verifyCalls: number } {
  const store: ApiKeyStore & { verifyCalls: number } = {
    name: "fake",
    verifyCalls: 0,
    async verify(rawKey: string) {
      store.verifyCalls += 1;
      return impl(rawKey);
    },
    async create() {
      throw new Error("unused in lane guard tests");
    },
    async list() {
      throw new Error("unused in lane guard tests");
    },
    async revoke() {
      throw new Error("unused in lane guard tests");
    },
    async rotate() {
      throw new Error("unused in lane guard tests");
    },
    async close() {},
  };
  return store;
}

function expectCreated(res: CreateApiKeyResult) {
  if (res.status !== "created") throw new Error(`expected created, got ${res.status}`);
  return res.issued;
}

/** Minimal chat-shaped app: the handler echoes the attached lane and counts calls. */
function echoApp(store: ApiKeyStore) {
  const app = Fastify();
  let handlerCalls = 0;
  const guard = createLaneGuard(app, store);
  app.post("/v1/chat/completions", { preHandler: guard }, async (request, reply) => {
    handlerCalls += 1;
    return reply.send({ lane: request.auth?.lane ?? null, auth: request.auth ?? null });
  });
  return { app, handlerCalls: () => handlerCalls };
}

const post = (headers: Record<string, string> = {}) => ({
  method: "POST" as const,
  url: "/v1/chat/completions",
  headers,
  payload: { model: "gemini-3.6-flash", messages: [{ role: "user", content: "hi" }] },
});

describe("lane guard contract — header/lane matrix (T25)", () => {
  it("no key at all -> 401 missing_api_key with register hint; handler never runs", async () => {
    const { app, handlerCalls } = echoApp(new InMemoryApiKeyStore());
    const res = await app.inject(post({ "x-request-id": "req-1" }));
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("missing_api_key");
    expect(body.error.request_id).toBe("req-1");
    expect(res.headers["x-request-id"]).toBe("req-1");
    expect(body.error.message).toContain("POST /v1/register");
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "request_id"]);
    expect(handlerCalls()).toBe(0);
  });

  it("blank headers count as absent and generate a request id when none is sent", async () => {
    const { app, handlerCalls } = echoApp(new InMemoryApiKeyStore());
    const res = await app.inject(post({ "x-api-key": "   ", "x-provider-key": "   " }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("missing_api_key");
    expect(res.json().error.request_id).toBe(res.headers["x-request-id"]);
    expect(handlerCalls()).toBe(0);
  });

  it("bad gateway key -> 401 invalid_api_key; the key never appears in the body", async () => {
    const { app, handlerCalls } = echoApp(seededStore("acme:gemini:main:lg_validseed123"));
    const res = await app.inject(post({ authorization: "Bearer lg_boguskey999" }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
    expect(res.body).not.toContain("lg_boguskey999");
    expect(handlerCalls()).toBe(0);
  });

  it("malformed Authorization is a failed registered attempt (401), never an anonymous fallback", async () => {
    const { app, handlerCalls } = echoApp(seededStore("acme:gemini:main:lg_validseed123"));
    for (const authorization of ["Basic dXNlcjpwdw==", "Bearer", "Token lg_whatever"]) {
      const res = await app.inject(post({ authorization, "x-provider-key": "sk-upstream-42" }));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("invalid_api_key");
      expect(res.body).not.toContain("sk-upstream-42");
    }
    expect(handlerCalls()).toBe(0);
  });

  it("valid gateway key -> registered lane with tenant, provider and keyId attached (no key material)", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    const spy = fakeStore((rawKey) => store.verify(rawKey));
    const { app, handlerCalls } = echoApp(spy);

    const res = await app.inject(post({ authorization: `Bearer ${issued.key}` }));
    expect(res.statusCode).toBe(200);
    expect(res.json().auth).toEqual({
      lane: "registered",
      tenant: "acme",
      provider: "gemini",
      keyId: issued.record.id,
    });
    expect(spy.verifyCalls).toBe(1);
    expect(handlerCalls()).toBe(1);
    expect(res.body).not.toContain(issued.key);
  });

  it("x-api-key alias verifies as the registered lane", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    const { app } = echoApp(store);
    const res = await app.inject(post({ "x-api-key": issued.key }));
    expect(res.statusCode).toBe(200);
    expect(res.json().auth).toEqual({
      lane: "registered",
      tenant: "acme",
      provider: "gemini",
      keyId: issued.record.id,
    });
  });

  it("precedence: Authorization beats x-api-key (an invalid Authorization does not fall through)", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    const { app } = echoApp(store);
    const res = await app.inject(post({ authorization: "Bearer lg_bogus", "x-api-key": issued.key }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
  });

  it("precedence: a gateway key picks registered even when x-provider-key is also present", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    const { app } = echoApp(store);
    const res = await app.inject(post({ authorization: `Bearer ${issued.key}`, "x-provider-key": "sk-upstream-42" }));
    expect(res.statusCode).toBe(200);
    expect(res.json().auth.lane).toBe("registered");
    expect(res.body).not.toContain("sk-upstream-42");
  });

  it("anonymous lane: x-provider-key is attached and the store is never consulted", async () => {
    const store = fakeStore(async () => ({ status: "invalid" }));
    const { app, handlerCalls } = echoApp(store);
    const res = await app.inject(post({ "x-provider-key": "sk-upstream-42" }));
    expect(res.statusCode).toBe(200);
    expect(res.json().auth).toEqual({ lane: "anonymous", providerKey: "sk-upstream-42" });
    expect(store.verifyCalls).toBe(0);
    expect(handlerCalls()).toBe(1);
  });

  it("revoked key -> 403 key_revoked; no key material in the body", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    await store.revoke(issued.record.id);
    const { app, handlerCalls } = echoApp(store);
    const res = await app.inject(post({ authorization: `Bearer ${issued.key}` }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("key_revoked");
    expect(res.body).not.toContain(issued.key);
    expect(handlerCalls()).toBe(0);
  });

  it("expired key -> 403 key_expired; no key material in the body", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(
      await store.create({
        tenant: "acme",
        provider: "gemini",
        name: "old",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const { app, handlerCalls } = echoApp(store);
    const res = await app.inject(post({ authorization: `Bearer ${issued.key}` }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("key_expired");
    expect(res.body).not.toContain(issued.key);
    expect(handlerCalls()).toBe(0);
  });

  it("store down -> 503 auth_unavailable; driver context stays out of the client body", async () => {
    const store = fakeStore(async () => ({ status: "unavailable", reason: "connect ECONNREFUSED 127.0.0.1:5432" }));
    const { app, handlerCalls } = echoApp(store);
    const res = await app.inject(post({ authorization: "Bearer lg_anything" }));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_unavailable");
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("lg_anything");
    expect(handlerCalls()).toBe(0);
  });

  it("lane state is per request: a rejection never sees a previously attached lane", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    const { app, handlerCalls } = echoApp(store);
    expect((await app.inject(post({ authorization: `Bearer ${issued.key}` }))).statusCode).toBe(200);
    const second = await app.inject(post());
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe("missing_api_key");
    expect(handlerCalls()).toBe(1);
  });

  it("createLaneGuard is idempotent per app (chat + usage will share one app)", async () => {
    const store = new InMemoryApiKeyStore();
    const app = Fastify();
    const first = createLaneGuard(app, store);
    const second = createLaneGuard(app, store); // must not throw 'decorator already added'
    app.post("/v1/chat/completions", { preHandler: first }, async () => ({ ok: 1 }));
    app.post("/v1/usage", { preHandler: second }, async () => ({ ok: 2 }));
    expect((await app.inject(post())).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/usage" })).statusCode).toBe(401);
  });

  it("auth_rejects_total counts every guard rejection (401/403/503) and no success (T27/R1)", async () => {
    metrics.reset();
    const store = new InMemoryApiKeyStore();
    const valid = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    const revoked = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "rev" }));
    await store.revoke(revoked.record.id);
    const expired = expectCreated(
      await store.create({
        tenant: "acme",
        provider: "gemini",
        name: "exp",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const down = fakeStore(async () => ({ status: "unavailable", reason: "pool down" }));
    const { app } = echoApp(store);
    const { app: downApp } = echoApp(down);

    expect((await app.inject(post())).statusCode).toBe(401); // missing everything
    expect((await app.inject(post({ authorization: "Bearer lg_bogus" }))).statusCode).toBe(401); // invalid key
    expect((await app.inject(post({ authorization: `Bearer ${revoked.key}` }))).statusCode).toBe(403); // revoked
    expect((await app.inject(post({ authorization: `Bearer ${expired.key}` }))).statusCode).toBe(403); // expired
    expect((await downApp.inject(post({ authorization: "Bearer lg_anything" }))).statusCode).toBe(503); // store down
    expect(metrics.snapshot().auth_rejects_total).toBe(5);

    // Accepted lanes — registered and anonymous — never touch the counter.
    expect((await app.inject(post({ authorization: `Bearer ${valid.key}` }))).statusCode).toBe(200);
    expect((await app.inject(post({ "x-provider-key": "sk-anon-counter" }))).statusCode).toBe(200);
    expect(metrics.snapshot().auth_rejects_total).toBe(5);
  });
});

describe("lane provider mismatch (T25)", () => {
  function routedApp(store: ApiKeyStore, servingProvider: string) {
    const app = Fastify();
    const guard = createLaneGuard(app, store);
    app.post("/v1/chat/completions", { preHandler: guard }, async (request, reply) => {
      const gw = laneProviderMismatch(request.auth!, servingProvider);
      if (gw) {
        return reply.status(gw.status).send({ error: { code: gw.code, message: gw.message, request_id: "req-m" } });
      }
      return reply.send({ ok: true, lane: request.auth?.lane ?? null });
    });
    return app;
  }

  it("registered key serving another provider -> 403 provider_mismatch; matching provider and anonymous pass", async () => {
    const store = new InMemoryApiKeyStore();
    const gemini = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "g" }));
    const openai = expectCreated(await store.create({ tenant: "acme", provider: "openai", name: "o" }));
    const app = routedApp(store, "openai"); // the model routes to openai

    const bad = await app.inject(post({ authorization: `Bearer ${gemini.key}` }));
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("provider_mismatch");
    expect(bad.body).not.toContain(gemini.key);

    const good = await app.inject(post({ authorization: `Bearer ${openai.key}` }));
    expect(good.statusCode).toBe(200);
    expect(good.json().lane).toBe("registered");

    const anon = await app.inject(post({ "x-provider-key": "sk-upstream-42" }));
    expect(anon.statusCode).toBe(200);
    expect(anon.json().lane).toBe("anonymous");
  });

  it("laneProviderMismatch is pure, lane-aware, and key-material-free", () => {
    const registered: LaneAuth = { lane: "registered", tenant: "acme", provider: "gemini", keyId: "kid-1" };
    expect(laneProviderMismatch(registered, "gemini")).toBeNull();
    expect(laneProviderMismatch({ lane: "anonymous", providerKey: "sk-x" }, "openai")).toBeNull();

    const gw = laneProviderMismatch(registered, "openai");
    expect(gw).toBeInstanceOf(GatewayError);
    expect(gw).toMatchObject({ status: 403, code: "provider_mismatch" });
    expect(gw!.message).toContain("gemini");
    expect(gw!.message).toContain("openai");
  });
});

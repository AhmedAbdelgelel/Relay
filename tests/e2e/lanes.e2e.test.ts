
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiKeyStore } from "../../src/auth/ApiKeyStore.js";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { GatewayError } from "../../src/domain/types.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { laneAuth } from "../helpers/lane.js";
import { chat, json, makeApp, sendJson, ScriptedProvider, startFakeUpstream } from "./harness.js";

const VALID = { model: "m", messages: [{ role: "user", content: "hello lane" }] };

beforeEach(() => metrics.reset());

function spyApiKeys(inner: ApiKeyStore, hooks: { onVerify?: () => void } = {}): ApiKeyStore {
  return {
    name: inner.name,
    verify: (raw) => {
      hooks.onVerify?.();
      return inner.verify(raw);
    },
    create: (input) => inner.create(input),
    list: (tenant) => inner.list(tenant),
    revoke: (id) => inner.revoke(id),
    rotate: (id) => inner.rotate(id),
    close: () => inner.close(),
  };
}

function downApiKeys(): ApiKeyStore {
  const fail = async () => ({ status: "unavailable" as const, reason: "ECONNREFUSED 127.0.0.1:5432 pg-internal" });
  return {
    name: "down-keys",
    verify: fail,
    create: fail,
    list: fail,
    revoke: fail,
    rotate: fail,
    close: async () => undefined,
  };
}

function downCredentials(): CredentialStore {
  const reason = "ECONNREFUSED 127.0.0.1:5432 pg-internal";
  return {
    name: "down-cred",
    save: async () => ({ status: "unavailable", reason }),
    get: async () => ({ status: "unavailable", reason }),
    list: async () => ({ status: "unavailable", reason }),
    remove: async () => ({ status: "unavailable", reason }),
    close: async () => undefined,
  };
}

function spyCache(inner: InMemoryCache, sets: string[]): CacheRepository {
  return {
    name: "spy-cache",
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

describe("lane guard", () => {
  it("no key -> 401 missing_api_key with register hint; no lane headers, provider untouched", async () => {
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ provider });
    const res = await chat(app, null, VALID);
    expect(res.statusCode).toBe(401);
    const body = json<{ error: { code: string; message: string; request_id: string } }>(res);
    expect(body.error.code).toBe("missing_api_key");
    expect(body.error.message).toContain("register");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-lane"]).toBeUndefined();
    expect(provider.calls).toBe(0);
    expect(metrics.snapshot().auth_rejects_total).toBe(1);
    await app.close();
  });

  it("invalid key -> 401 invalid_api_key; key material never echoed", async () => {
    const { app } = makeApp();
    const res = await chat(app, "lg_bogus_key_material", VALID);
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe("invalid_api_key");
    expect(res.body).not.toContain("lg_bogus_key_material");
    await app.close();
  });

  it("malformed Authorization is a failed attempt, never an anonymous fallback", async () => {
    const { app } = makeApp();
    const res = await chat(app, null, VALID, { authorization: "Token abc", "x-provider-key": "sk-anon" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-lane"]).toBeUndefined();
    await app.close();
  });

  it("blank Authorization counts as absent", async () => {
    const { app } = makeApp();
    const res = await chat(app, null, VALID, { authorization: "   " });
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe("missing_api_key");
    await app.close();
  });

  it("x-api-key alias verifies as the registered lane", async () => {
    const lanes = await laneAuth("mock");
    const { app } = makeApp({ auth: lanes.auth });
    const lane = lanes.laneFor("mock");
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": lane.key }, payload: VALID });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-lane"]).toBe("registered");
    expect(res.headers["x-key-id"]).toBe(lane.keyId);
    await app.close();
  });

  it("precedence: Authorization beats x-api-key; a valid gateway key beats x-provider-key", async () => {
    const lanes = await laneAuth("mock");
    const { app } = makeApp({ auth: lanes.auth });
    const lane = lanes.laneFor("mock");

    const bad = await chat(app, null, VALID, { authorization: "Bearer lg_wrong", "x-api-key": lane.key });
    expect(bad.statusCode).toBe(401);

    const both = await chat(app, lane.key, VALID, { "x-provider-key": "sk-try-out" });
    expect(both.statusCode).toBe(200);
    expect(both.headers["x-lane"]).toBe("registered");
    await app.close();
  });

  it("anonymous x-provider-key: BYPASS twice, no verify, nothing written, provider runs each time", async () => {
    const lanes = await laneAuth("mock");
    let verified = false;
    const apiKeys = spyApiKeys(lanes.auth.apiKeys, { onVerify: () => (verified = true) });
    const sets: string[] = [];
    const cache = spyCache(new InMemoryCache(), sets);
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: { apiKeys, credentials: lanes.auth.credentials }, cache, provider });

    const headers = { "x-provider-key": "sk-try-out" };
    const first = await chat(app, null, VALID, headers);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-lane"]).toBe("anonymous");
    expect(first.headers["x-cache"]).toBe("BYPASS");
    const second = await chat(app, null, VALID, headers);
    expect(second.headers["x-cache"]).toBe("BYPASS");
    expect(second.headers["x-provider"]).toBe("mock");
        expect(metrics.snapshot().provider_requests).toBe(2);
    expect(verified).toBe(false);
    expect(sets).toEqual([]);
    await app.close();
  });

  it("anonymous BYPASS neither reads nor seeds the registered lane's exact entry", async () => {
    const lanes = await laneAuth("mock");
    const provider = new ScriptedProvider("mock");
    const { app } = makeApp({ auth: lanes.auth, provider });
    const lane = lanes.laneFor("mock");

    const seed = await chat(app, lane.key, VALID);
    expect(seed.headers["x-cache"]).toBe("MISS");
    expect(seed.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("scripted(mock): hello lane");

    const anon = await chat(app, null, VALID, { "x-provider-key": "sk-anon" });
    expect(anon.statusCode).toBe(200);
    expect(anon.headers["x-cache"]).toBe("BYPASS");
    expect(anon.headers["x-cache-hash"]).toBeTruthy();
    expect(anon.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toContain("mock echo (m): hello lane");
    expect(provider.calls).toBe(1);

    const replay = await chat(app, lane.key, VALID);
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(replay.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("scripted(mock): hello lane");
    expect(provider.calls).toBe(1);

    const m = metrics.snapshot();
    expect(m.exact_misses).toBe(1);
    expect(m.exact_hits).toBe(1);
    expect(m.provider_requests).toBe(2);
    await app.close();
  });

  it("revoked key -> 403 key_revoked; expired key -> 403 key_expired", async () => {
    const lanes = await laneAuth("mock");
    const { app } = makeApp({ auth: lanes.auth });

    const lane = lanes.laneFor("mock");
    await lanes.auth.apiKeys.revoke(lane.keyId);
    const revoked = await chat(app, lane.key, VALID);
    expect(revoked.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(revoked).error.code).toBe("key_revoked");
    expect(revoked.body).not.toContain(lane.key);

    const past = new Date(Date.now() - 60_000).toISOString();
    const created = await lanes.auth.apiKeys.create({ tenant: "t-exp", provider: "mock", name: "expired", expiresAt: past });
    if (created.status !== "created") throw new Error("key create failed");
    const expired = await chat(app, created.issued.key, VALID);
    expect(expired.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(expired).error.code).toBe("key_expired");
    await app.close();
  });

  it("store down -> 503 auth_unavailable; driver details stay out of the body", async () => {
    const { app } = makeApp({ auth: { apiKeys: downApiKeys(), credentials: downCredentials() } });
    const res = await chat(app, "lg_any", VALID);
    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code).toBe("auth_unavailable");
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("5432");
    await app.close();
  });

  it("provider mismatch: routed target differs from the key's binding -> 403, nothing spent", async () => {
            const upstream = await startFakeUpstream((_hit, res) =>
      sendJson(res, 200, { id: "or-1", model: "x/y:free", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const lanes = await laneAuth("mock");
    const mock = new ScriptedProvider("mock");
    const openrouter = new ScriptedProvider("openrouter");
    const providers = new Map([
      ["mock", mock],
      ["openrouter", openrouter],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers, env: { OPENROUTER_BASE_URL: upstream.url } });

    const mismatch = await chat(app, lanes.laneFor("mock").key, { model: "x/y:free", messages: VALID.messages });
    expect(mismatch.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(mismatch).error.code).toBe("provider_mismatch");
    expect(openrouter.calls).toBe(0);
    expect(mock.calls).toBe(0);

    const matching = await chat(app, lanes.laneFor("mock").key, VALID);
    expect(matching.statusCode).toBe(200);
    expect(matching.headers["x-provider"]).toBe("mock");

    const anonymous = await chat(app, null, { model: "x/y:free", messages: VALID.messages }, { "x-provider-key": "sk-try-out-key" });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.headers["x-lane"]).toBe("anonymous");
    expect(anonymous.headers["x-provider"]).toBe("openrouter");
    expect(upstream.hits.length).toBe(1);
    expect(upstream.hits[0]!.headers.authorization).toBe("Bearer sk-try-out-key");
    await upstream.close();
    await app.close();
  });

  it("GATEWAY_API_KEYS seeds verify exactly like issued keys", async () => {
    const { app } = makeApp({ env: { GATEWAY_API_KEYS: "acme:mock:seed:lg_seeded_key" } });
    const res = await chat(app, "lg_seeded_key", VALID);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-lane"]).toBe("registered");
    expect(res.headers["x-key-id"]).toBeTruthy();
    await app.close();
  });

  it("auth_rejects_total counts every rejection and never a success", async () => {
    const lanes = await laneAuth("mock");
    const mock = new ScriptedProvider("mock");
    const providers = new Map([
      ["mock", mock],
      ["openrouter", new ScriptedProvider("openrouter")],
    ]);
    const { app } = makeApp({ auth: lanes.auth, provider: mock, providers });
    const key = lanes.laneFor("mock").key;

    await chat(app, null, VALID);
    await chat(app, "lg_nope", VALID);
    await chat(app, null, VALID, { authorization: "Token x" });
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-provider-key": "sk" }, payload: VALID });
    const revoked = await laneAuth("mock");
    await revoked.auth.apiKeys.revoke(revoked.laneFor("mock").keyId);
    const app2 = makeApp({ auth: revoked.auth });
    await chat(app2.app, revoked.laneFor("mock").key, VALID);
    await chat(app, key, { model: "x/y:free", messages: VALID.messages });
    await chat(app, key, VALID);

    expect(metrics.snapshot().auth_rejects_total).toBe(5);
    await app.close();
    await app2.app.close();
  });

  it("registered-lane failures still carry x-lane/x-key-id evidence (429 path)", async () => {
    const lanes = await laneAuth("mock");
    const failing = new MockProvider({ failure: "rate_limited" });
    const { app } = makeApp({ auth: lanes.auth, provider: failing });
    const lane = lanes.laneFor("mock");
    const res = await chat(app, lane.key, VALID);
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-lane"]).toBe("registered");
    expect(res.headers["x-key-id"]).toBe(lane.keyId);
    await app.close();
  });
});

describe("register + usage", () => {
  it("register -> chat (MISS then HIT) -> usage: the issued key works end-to-end", async () => {
    const { app } = makeApp();
    const reg = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: { name: "alice", provider: "mock", provider_key: "sk-stored-provider-key" },
    });
    expect(reg.statusCode).toBe(201);
    const issued = json<{ tenant_id: string; provider: string; key: string; key_prefix: string }>(reg);
    expect(Object.keys(issued).sort()).toEqual(["key", "key_prefix", "provider", "tenant_id"]);
    expect(issued.provider).toBe("mock");
    expect(issued.key.startsWith("lg_")).toBe(true);
    expect(issued.key.startsWith(issued.key_prefix)).toBe(true);
    expect(reg.body).not.toContain("sk-stored-provider-key");

    const first = await chat(app, issued.key, VALID);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    const second = await chat(app, issued.key, VALID);
    expect(second.headers["x-cache"]).toBe("HIT");

    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${issued.key}`, "x-tenant-id": "spoofed" } });
    expect(usage.statusCode).toBe(200);
    expect(usage.headers["x-request-id"]).toBeTruthy();
    const mine = json<{ tenant: string; requests: number; exact_hits: number; misses: number; provider_calls_avoided: number }>(usage);
    expect(mine.tenant).toBe(issued.tenant_id);
    expect(mine.requests).toBe(2);
    expect(mine.exact_hits).toBe(1);
    expect(mine.misses).toBe(1);
    expect(mine.provider_calls_avoided).toBe(1);
    await app.close();
  });

  it("register validation: 400s never touch a store and never count as auth rejections", async () => {
    const { app, auth } = makeApp();
    const cases: Record<string, unknown>[] = [
      { provider: "mock", provider_key: "k" },
      { name: "a", provider_key: "k" },
      { name: "a", provider: "mock" },
      { name: "", provider: "mock", provider_key: "k" },
      { name: "a", provider: "notaprovider", provider_key: "k" },
      { name: "a", provider: "mock", provider_key: "" },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: "POST", url: "/v1/register", payload });
      expect(res.statusCode).toBe(400);
      expect(json<{ error: { code: string } }>(res).error.code).toBe("invalid_request");
    }
    const listed = await auth.apiKeys.list();
    expect(listed.status === "ok" && listed.keys.length === 0).toBe(true);
    expect(metrics.snapshot().auth_rejects_total).toBe(0);
    await app.close();
  });

  it("register store outages: credential store down -> 503 before minting; key store down -> 503 (orphan documented)", async () => {
    const credDown = makeApp({ auth: { apiKeys: new InMemoryApiKeyStore(), credentials: downCredentials() } });
    const first = await credDown.app.inject({ method: "POST", url: "/v1/register", payload: { name: "a", provider: "mock", provider_key: "k" } });
    expect(first.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(first).error.code).toBe("auth_unavailable");
    const none = await credDown.auth.apiKeys.list();
    expect(none.status === "ok" && none.keys.length === 0).toBe(true);
    await credDown.app.close();

    let saves = 0;
    const innerCred = new InMemoryCredentialStore(new CredentialCipher("e2e-dev-secret"));
    const spyCred: CredentialStore = {
      name: innerCred.name,
      save: (t, p, k, u) => {
        saves++;
        return innerCred.save(t, p, k, u);
      },
      get: (t, p) => innerCred.get(t, p),
      list: (t) => innerCred.list(t),
      remove: (t, p) => innerCred.remove(t, p),
      close: () => innerCred.close(),
    };
    const keyDown = makeApp({ auth: { apiKeys: downApiKeys(), credentials: spyCred } });
    const second = await keyDown.app.inject({ method: "POST", url: "/v1/register", payload: { name: "b", provider: "mock", provider_key: "k" } });
    expect(second.statusCode).toBe(503);
    expect(saves).toBe(1);
    await keyDown.app.close();
  });

  it("usage 401 matrix: missing, anonymous and invalid are each counted once", async () => {
    const lanes = await laneAuth("mock");
    const { app } = makeApp({ auth: lanes.auth });
    const none = await app.inject({ method: "GET", url: "/v1/usage" });
    expect(none.statusCode).toBe(401);
    const anon = await app.inject({ method: "GET", url: "/v1/usage", headers: { "x-provider-key": "sk-anon" } });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: "Bearer lg_bad" } });
    expect(bad.statusCode).toBe(401);
    expect(metrics.snapshot().auth_rejects_total).toBe(3);
    await app.close();
  });

  it("usage isolates tenants: a second tenant's traffic never leaks into the first slice", async () => {
    const { app } = makeApp();
    const reg = async (name: string) => {
      const res = await app.inject({ method: "POST", url: "/v1/register", payload: { name, provider: "mock", provider_key: "k" } });
      return json<{ key: string; tenant_id: string }>(res);
    };
    const alice = await reg("alice");
    const bob = await reg("bob");
    await chat(app, alice.key, VALID);
    await chat(app, alice.key, VALID);
    await chat(app, bob.key, { model: "m", messages: [{ role: "user", content: "bob asks something else" }] });

    const usageFor = async (key: string) => json<{ tenant: string; requests: number }>(await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key}` } }));
    const a = await usageFor(alice.key);
    const b = await usageFor(bob.key);
    expect(a.tenant).toBe(alice.tenant_id);
    expect(a.requests).toBe(2);
    expect(b.tenant).toBe(bob.tenant_id);
    expect(b.requests).toBe(1);
    await app.close();
  });
});

describe("fallback cache discipline (INV-7)", () => {
  it("a fallback answer stays under the serving provider key when the primary recovers", async () => {
    let primaryDown = true;
    const primary = new ScriptedProvider("mock", {
      chat: async (req) => {
        if (primaryDown) throw new GatewayError(502, "provider_error", "primary down", false);
        return { id: "primary-1", model: req.model, content: "primary answer", usage: { prompt_tokens: 2, completion_tokens: 3 } };
      },
    });
    const alt = new ScriptedProvider("alt", {
      chat: async (req) => ({ id: "alt-1", model: req.model, content: "alt answer", usage: { prompt_tokens: 4, completion_tokens: 5 } }),
    });
    const providers = new Map([
      ["mock", primary],
      ["alt", alt],
    ]);
    const lanes = await laneAuth("mock");
    const { app } = makeApp({ auth: lanes.auth, provider: primary, providers });
    const lane = lanes.laneFor("mock").key;

    const first = await chat(app, lane, VALID);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-provider"]).toBe("alt");
    expect(first.headers["x-fallback"]).toBe("true");
    expect(primary.calls).toBe(1);
    expect(alt.calls).toBe(1);

    primaryDown = false;
    const replay = await chat(app, lane, VALID);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(replay.headers["x-provider"]).toBe("alt");
    expect(replay.headers["x-fallback"]).toBe("true");
    expect(replay.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe("alt answer");
    expect(primary.calls).toBe(1);
    expect(alt.calls).toBe(1);
    await app.close();
  });
});

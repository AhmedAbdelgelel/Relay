// Contract tests for the T24 ApiKeyStore port: lifecycle semantics
// (verify/create/list/revoke/rotate), hash-only storage, and the typed
// failure model a lane guard will build on. Runs against the in-memory
// backend directly and the pg backend through a fake SqlClient that captures
// executed SQL (the pgvector-sql precedent).

import { describe, expect, it } from "vitest";
import type { SqlClient } from "../../src/cache/PgVectorStore.js";
import {
  apiKeyPrefixOf,
  hashApiKey,
  type ApiKeyRecord,
  type CreateApiKeyResult,
  type VerifyApiKeyResult,
} from "../../src/auth/ApiKeyStore.js";
import { createAuthStoresFromEnv } from "../../src/auth/factory.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import { migrateAuthTables, PgApiKeyStore, PgCredentialStore } from "../../src/auth/PgAuthStores.js";
import { loadConfig } from "../../src/infrastructure/config.js";

type Seen = { text: string; params?: unknown[] };

function fakeDb(rows: unknown[] = [], impl: Partial<SqlClient> = {}): SqlClient & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      seen.push({ text, params });
      if (impl.query) return impl.query<T>(text, params);
      return { rows: rows as T[] };
    },
    async close() {},
  };
}

function expectCreated(res: CreateApiKeyResult) {
  if (res.status !== "created") throw new Error(`expected created, got ${res.status}`);
  return res.issued;
}

function expectValid(res: VerifyApiKeyResult): ApiKeyRecord {
  if (res.status !== "valid") throw new Error(`expected valid, got ${res.status}`);
  return res.key;
}

const UUID = "11111111-1111-1111-1111-111111111111";

function keyRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: UUID,
    tenant_id: "acme",
    provider: "mock",
    name: "dev",
    key_prefix: "lg_abcde",
    expires_at: null,
    revoked_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("ApiKeyStore contract — in-memory (T24)", () => {
  it("create returns the lg_ plaintext once with metadata; verify binds tenant + provider", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main" }));
    expect(issued.key.startsWith("lg_")).toBe(true);
    expect(issued.key.length).toBeGreaterThan(40);
    expect(issued.record).toMatchObject({
      tenant: "acme",
      provider: "gemini",
      name: "main",
      expiresAt: null,
      revokedAt: null,
    });
    expect(issued.record.keyPrefix).toBe(issued.key.slice(0, 8));
    expect(issued.record.keyPrefix).not.toBe(issued.key);

    const record = expectValid(await store.verify(issued.key));
    expect(record.id).toBe(issued.record.id);
    expect(record.tenant).toBe("acme");
    expect(record.provider).toBe("gemini");
  });

  it("create stores only the sha256 hash and prefix — never the plaintext", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "mock", name: "dev" }));
    const internals = store as unknown as {
      rows: Map<string, ApiKeyRecord>;
      byHash: Map<string, string>;
    };
    expect(internals.byHash.has(hashApiKey(issued.key))).toBe(true);
    expect(internals.byHash.has(issued.key)).toBe(false);
    expect(JSON.stringify([...internals.rows.values()])).not.toContain(issued.key);

    // list() is metadata only: no hash, no plaintext anywhere in the JSON.
    const listed = await store.list();
    if (listed.status !== "ok") throw new Error("expected ok");
    const json = JSON.stringify(listed.keys);
    expect(json).not.toContain(issued.key);
    expect(json).not.toContain(hashApiKey(issued.key));
    expect(Object.keys(listed.keys[0]!).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "keyPrefix", "name", "provider", "revokedAt", "tenant"].sort(),
    );
  });

  it("verify: unknown, empty, or garbage keys are invalid and never throw", async () => {
    const store = new InMemoryApiKeyStore();
    expect(await store.verify("lg_does-not-exist")).toEqual({ status: "invalid" });
    expect(await store.verify("")).toEqual({ status: "invalid" });
    expect(await store.verify("not-even-a-key")).toEqual({ status: "invalid" });
  });

  it("revoke: revoked keys fail verify, revokedAt is set, re-revoking is idempotent", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(await store.create({ tenant: "acme", provider: "mock", name: "dev" }));
    const first = await store.revoke(issued.record.id);
    if (first.status !== "revoked") throw new Error(`expected revoked, got ${first.status}`);
    expect(first.record.revokedAt).toBeTruthy();

    const res = await store.verify(issued.key);
    expect(res.status).toBe("revoked");
    if (res.status === "revoked") expect(res.key.tenant).toBe("acme");

    const second = await store.revoke(issued.record.id);
    if (second.status !== "revoked") throw new Error(`expected revoked, got ${second.status}`);
    expect(second.record.revokedAt).toBe(first.record.revokedAt);
  });

  it("revoke: unknown id is not_found", async () => {
    const store = new InMemoryApiKeyStore();
    expect(await store.revoke("no-such-id")).toEqual({ status: "not_found" });
  });

  it("verify: expired keys fail, future expiry passes", async () => {
    const store = new InMemoryApiKeyStore();
    const expired = expectCreated(
      await store.create({
        tenant: "acme",
        provider: "mock",
        name: "old",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await store.verify(expired.key)).toMatchObject({ status: "expired" });

    const live = expectCreated(
      await store.create({
        tenant: "acme",
        provider: "mock",
        name: "live",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect((await store.verify(live.key)).status).toBe("valid");
  });

  it("verify: revoked takes precedence over expired", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = expectCreated(
      await store.create({
        tenant: "acme",
        provider: "mock",
        name: "both",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    await store.revoke(issued.record.id);
    expect((await store.verify(issued.key)).status).toBe("revoked");
  });

  it("rotate invalidates the old key and issues a replacement with the same identity", async () => {
    const store = new InMemoryApiKeyStore();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const old = expectCreated(await store.create({ tenant: "acme", provider: "gemini", name: "main", expiresAt }));

    const res = await store.rotate(old.record.id);
    if (res.status !== "rotated") throw new Error(`expected rotated, got ${res.status}`);
    expect(res.issued.key).not.toBe(old.key);
    expect(res.issued.record).toMatchObject({ tenant: "acme", provider: "gemini", name: "main", expiresAt });
    expect(res.issued.record.id).not.toBe(old.record.id);

    expect((await store.verify(old.key)).status).toBe("revoked");
    expect(expectValid(await store.verify(res.issued.key)).tenant).toBe("acme");
  });

  it("rotate: unknown id is not_found; a revoked id can still be rotated (re-issue path)", async () => {
    const store = new InMemoryApiKeyStore();
    expect(await store.rotate("no-such-id")).toEqual({ status: "not_found" });

    const issued = expectCreated(await store.create({ tenant: "acme", provider: "mock", name: "dev" }));
    await store.revoke(issued.record.id);
    const res = await store.rotate(issued.record.id);
    expect(res.status).toBe("rotated");
  });

  it("list filters by tenant, includes revoked rows flagged, and isolates tenants", async () => {
    const store = new InMemoryApiKeyStore();
    const a = expectCreated(await store.create({ tenant: "acme", provider: "mock", name: "a" }));
    await store.create({ tenant: "acme", provider: "mock", name: "b" });
    await store.create({ tenant: "bob", provider: "mock", name: "c" });
    await store.revoke(a.record.id);

    const all = await store.list();
    if (all.status !== "ok") throw new Error("expected ok");
    expect(all.keys).toHaveLength(3);

    const acme = await store.list("acme");
    if (acme.status !== "ok") throw new Error("expected ok");
    expect(acme.keys.map((k) => k.name).sort()).toEqual(["a", "b"]);
    expect(acme.keys.find((k) => k.name === "a")?.revokedAt).toBeTruthy();
    expect(acme.keys.find((k) => k.name === "c")).toBeUndefined();
  });

  it("seeds from GATEWAY_API_KEYS config verify exactly like created keys", async () => {
    const cfg = loadConfig({
      PROVIDER: "mock",
      GATEWAY_API_KEYS: "acme:gemini:main:lg_seedkey123, bob:openai:dev:lg_seedkey456",
    } as NodeJS.ProcessEnv);
    const store = new InMemoryApiKeyStore(cfg.gatewayApiKeys);
    const record = expectValid(await store.verify("lg_seedkey123"));
    expect(record).toMatchObject({ tenant: "acme", provider: "gemini", name: "main" });
    expect(record.keyPrefix).toBe("lg_seedk");

    const listed = await store.list();
    if (listed.status !== "ok") throw new Error("expected ok");
    expect(listed.keys).toHaveLength(2);
    expect(JSON.stringify(listed.keys)).not.toContain("lg_seedkey123");
  });
});

describe("ApiKeyStore contract — pg (SQL shape, fake SqlClient)", () => {
  it("create sends only hash + prefix to the database and returns the plaintext once", async () => {
    const db = fakeDb([{ id: UUID, created_at: new Date("2026-01-01T00:00:00Z") }]);
    const issued = expectCreated(await new PgApiKeyStore(db).create({ tenant: "acme", provider: "mock", name: "dev" }));
    const q = db.seen[0]!;
    expect(q.text).toContain("INSERT INTO api_keys");
    expect(q.text).toContain("key_hash");
    expect(q.text).toContain("key_prefix");
    expect(q.params?.[3]).toBe(issued.record.keyPrefix);
    expect(q.params?.[4]).toBe(hashApiKey(issued.key));
    expect(q.params).not.toContain(issued.key); // plaintext never reaches the store
    expect(issued.record.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("verify looks up by key_hash only and maps a valid row", async () => {
    const db = fakeDb([keyRow()]);
    const res = await new PgApiKeyStore(db).verify("lg_presentedkey");
    expect(res).toMatchObject({ status: "valid", key: { tenant: "acme", provider: "mock", name: "dev" } });
    const q = db.seen[0]!;
    expect(q.text).toContain("WHERE key_hash = $1");
    expect(q.params).toEqual([hashApiKey("lg_presentedkey")]); // hash only, no plaintext
  });

  it("verify maps revoked and expired rows, and unknown rows to invalid", async () => {
    const revoked = await new PgApiKeyStore(
      fakeDb([keyRow({ revoked_at: new Date("2026-02-01T00:00:00Z") })]),
    ).verify("lg_x");
    expect(revoked.status).toBe("revoked");

    const expired = await new PgApiKeyStore(
      fakeDb([keyRow({ expires_at: new Date("2026-01-01T00:00:00Z") })]),
    ).verify("lg_x");
    expect(expired.status).toBe("expired");

    const unknown = await new PgApiKeyStore(fakeDb([])).verify("lg_x");
    expect(unknown).toEqual({ status: "invalid" });
  });

  it("verify: store down surfaces as unavailable with message context, never an exception", async () => {
    const db = fakeDb([], {
      query: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
    });
    const res = await new PgApiKeyStore(db).verify("lg_x");
    expect(res).toEqual({ status: "unavailable", reason: expect.stringContaining("ECONNREFUSED") });
  });

  it("revoke is an idempotent UPDATE ... COALESCE(revoked_at, now()) and not_found on unknown ids", async () => {
    const db = fakeDb([keyRow({ revoked_at: new Date("2026-02-01T00:00:00Z") })]);
    const res = await new PgApiKeyStore(db).revoke(UUID);
    expect(res.status).toBe("revoked");
    const q = db.seen[0]!;
    expect(q.text).toContain("UPDATE api_keys");
    expect(q.text).toContain("COALESCE(revoked_at, now())");
    expect(q.params).toEqual([UUID]);

    const empty = fakeDb([]);
    expect(await new PgApiKeyStore(empty).revoke(UUID)).toEqual({ status: "not_found" });
    const malformed = fakeDb([]);
    expect(await new PgApiKeyStore(malformed).revoke("not-a-uuid")).toEqual({ status: "not_found" });
    expect(malformed.seen).toHaveLength(0); // no malformed query reaches the db
  });

  it("rotate revokes + reinserts atomically in one statement; params carry only hash + prefix", async () => {
    const db = fakeDb([keyRow({ id: "22222222-2222-2222-2222-222222222222" })]);
    const res = await new PgApiKeyStore(db).rotate(UUID);
    if (res.status !== "rotated") throw new Error(`expected rotated, got ${res.status}`);
    expect(db.seen).toHaveLength(1); // single atomic statement
    const q = db.seen[0]!;
    expect(q.text).toContain("WITH old AS");
    expect(q.text).toContain("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())");
    expect(q.text).toContain("INSERT INTO api_keys");
    expect(q.params?.[0]).toBe(UUID);
    expect(q.params?.[1]).toBe(apiKeyPrefixOf(res.issued.key));
    expect(q.params?.[2]).toBe(hashApiKey(res.issued.key));
    expect(q.params).not.toContain(res.issued.key);
    expect(res.issued.record.keyPrefix).toBe("lg_abcde"); // record maps the RETURNING row

    expect(await new PgApiKeyStore(fakeDb([])).rotate(UUID)).toEqual({ status: "not_found" });
    expect(await new PgApiKeyStore(fakeDb([])).rotate("nope")).toEqual({ status: "not_found" });
  });

  it("list: tenant filter is parameterized and rows map to metadata only", async () => {
    const db = fakeDb([keyRow()]);
    const res = await new PgApiKeyStore(db).list("acme");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.keys[0]).toMatchObject({ tenant: "acme", keyPrefix: "lg_abcde" });
    expect(db.seen[0]!.text).toContain("WHERE tenant_id = $1");
    expect(db.seen[0]!.params).toEqual(["acme"]);

    const all = fakeDb([keyRow()]);
    expect((await new PgApiKeyStore(all).list()).status).toBe("ok");
    expect(all.seen[0]!.text).not.toContain("WHERE");
  });

  it("mutations surface store-down as unavailable (never throw)", async () => {
    const down = () =>
      fakeDb([], {
        query: async () => {
          throw new Error("db down");
        },
      });
    expect((await new PgApiKeyStore(down()).create({ tenant: "a", provider: "b", name: "c" })).status).toBe(
      "unavailable",
    );
    expect((await new PgApiKeyStore(down()).list()).status).toBe("unavailable");
    expect((await new PgApiKeyStore(down()).revoke(UUID)).status).toBe("unavailable");
    expect((await new PgApiKeyStore(down()).rotate(UUID)).status).toBe("unavailable");
  });
});

describe("auth table boot migration (T24)", () => {
  it("creates both tables with the 002 constraints", async () => {
    const db = fakeDb();
    await migrateAuthTables(db);
    const all = db.seen.map((s) => s.text).join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS api_keys");
    expect(all).toContain("key_hash TEXT NOT NULL UNIQUE");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS provider_credentials");
    expect(all).toContain("PRIMARY KEY (tenant_id, provider)");
  });
});

describe("auth factory (T24)", () => {
  it("zero-setup: no DATABASE_URL -> in-memory stores seeded from config", async () => {
    const cfg = loadConfig({
      PROVIDER: "mock",
      GATEWAY_API_KEYS: "acme:gemini:main:lg_seedkey123",
    } as NodeJS.ProcessEnv);
    const stores = await createAuthStoresFromEnv(cfg);
    expect(stores.apiKeys.name).toBe("memory");
    expect(stores.credentials.name).toBe("memory");
    const record = expectValid(await stores.apiKeys.verify("lg_seedkey123"));
    expect(record.tenant).toBe("acme");
    await stores.close();
    expect(await stores.apiKeys.verify("lg_seedkey123")).toEqual({ status: "invalid" });
  });
});

describe("CredentialStore contract — connections (BYO key + URL)", () => {
  const cipher = new CredentialCipher("contract-secret");

  it("memory: save/get/list round-trips the URL and replaces on reconnect", async () => {
    const store = new InMemoryCredentialStore(cipher);
    expect(await store.get("t1", "openrouter")).toEqual({ status: "not_found" });

    await store.save("t1", "openrouter", "sk-a", "http://localhost:4300/v1");
    expect(await store.get("t1", "openrouter")).toEqual({
      status: "ok",
      providerKey: "sk-a",
      baseUrl: "http://localhost:4300/v1",
    });

    // A reconnect without a URL resets to the gateway endpoint (no stale URL).
    await store.save("t1", "openrouter", "sk-b");
    expect(await store.get("t1", "openrouter")).toEqual({ status: "ok", providerKey: "sk-b", baseUrl: null });

    await store.save("t1", "openai", "sk-c", null);
    const listed = await store.list("t1");
    if (listed.status !== "ok") throw new Error(`expected ok, got ${listed.status}`);
    expect(listed.connections.map((c) => c.provider)).toEqual(["openai", "openrouter"]);
    expect(listed.connections[0]!.baseUrl).toBeNull();
    expect(JSON.stringify(listed.connections)).not.toContain("sk-");

    await store.remove("t1", "openai");
    const after = await store.list("t1");
    if (after.status !== "ok") throw new Error(`expected ok, got ${after.status}`);
    expect(after.connections.map((c) => c.provider)).toEqual(["openrouter"]);
  });

  it("pg: save upserts enc_key + base_url; get/list map rows; outages never throw", async () => {
    const saveDb = fakeDb();
    await new PgCredentialStore(saveDb, cipher).save("t9", "openai", "sk-live", "http://127.0.0.1:9/v1");
    const insert = saveDb.seen[0]!;
    expect(insert.text).toContain("INSERT INTO provider_credentials (tenant_id, provider, enc_key, base_url)");
    expect(insert.text).toContain("base_url = EXCLUDED.base_url");
    expect(insert.params?.[0]).toBe("t9");
    expect(insert.params?.[1]).toBe("openai");
    expect(insert.params?.[2]).not.toBe("sk-live"); // encrypted at rest
    expect(insert.params?.[3]).toBe("http://127.0.0.1:9/v1");

    const noUrlDb = fakeDb();
    await new PgCredentialStore(noUrlDb, cipher).save("t9", "ollama", "k");
    expect(noUrlDb.seen[0]!.params?.[3]).toBeNull();

    const getDb = fakeDb([{ enc_key: cipher.encrypt("sk-pg"), base_url: "https://proxy.internal/v1" }]);
    expect(await new PgCredentialStore(getDb, cipher).get("t9", "gemini")).toEqual({
      status: "ok",
      providerKey: "sk-pg",
      baseUrl: "https://proxy.internal/v1",
    });
    expect(getDb.seen[0]!.text).toContain("base_url");

    const listDb = fakeDb([{ provider: "openai", base_url: null, created_at: new Date("2026-02-02T00:00:00Z") }]);
    expect(await new PgCredentialStore(listDb, cipher).list("t9")).toEqual({
      status: "ok",
      connections: [{ provider: "openai", baseUrl: null, createdAt: "2026-02-02T00:00:00.000Z" }],
    });

    const down = () =>
      fakeDb([], {
        query: async () => {
          throw new Error("db down");
        },
      });
    expect((await new PgCredentialStore(down(), cipher).save("t", "p", "k")).status).toBe("unavailable");
    expect((await new PgCredentialStore(down(), cipher).get("t", "p")).status).toBe("unavailable");
    expect((await new PgCredentialStore(down(), cipher).list("t")).status).toBe("unavailable");
    expect((await new PgCredentialStore(down(), cipher).remove("t", "p")).status).toBe("unavailable");
  });

  it("boot migration adds base_url for existing provider_credentials tables", async () => {
    const db = fakeDb();
    await migrateAuthTables(db);
    const all = db.seen.map((s) => s.text).join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS provider_credentials");
    expect(all).toContain("base_url TEXT NULL");
    expect(all).toContain("ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS base_url TEXT NULL");
  });
});

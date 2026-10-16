// Contract tests for the T24 CredentialStore port and its AES-256-GCM cipher:
// encrypt-on-write/decrypt-on-read round-trip, plaintext never in stored rows,
// tamper/wrong-key failures loud, and the typed store-down result. In-memory
// backend runs directly; pg backend runs through a fake SqlClient that
// captures executed SQL (the pgvector-sql precedent).

import { describe, expect, it } from "vitest";
import type { SqlClient } from "../../src/cache/PgVectorStore.js";
import { createAuthStoresFromEnv } from "../../src/auth/factory.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import { PgCredentialStore } from "../../src/auth/PgAuthStores.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
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

function expectOk(providerKey: Awaited<ReturnType<InMemoryCredentialStore["get"]>>): string {
  if (providerKey.status !== "ok") throw new Error(`expected ok, got ${providerKey.status}`);
  return providerKey.providerKey;
}

describe("CredentialStore contract — in-memory (T24)", () => {
  it("save/get round-trips the provider key; the stored row never holds plaintext", async () => {
    const cipher = new CredentialCipher("s3cret");
    const store = new InMemoryCredentialStore(cipher);
    expect(await store.save("acme", "gemini", "sk-provider-123")).toEqual({ status: "ok" });
    expect(await store.get("acme", "gemini")).toEqual({ status: "ok", providerKey: "sk-provider-123" });

    // White-box: pin the "rows never hold plaintext" contract directly.
    const internals = store as unknown as { rows: Map<string, Map<string, { encKey: string }>> };
    const stored = internals.rows.get("acme")?.get("gemini");
    expect(stored).toBeDefined();
    expect(stored!.encKey.startsWith("v1:")).toBe(true);
    expect(stored!.encKey).not.toContain("sk-provider-123");
    expect(cipher.decrypt(stored!.encKey)).toBe("sk-provider-123");
  });

  it("isolates tenants and providers; unknown pairs are not_found", async () => {
    const store = new InMemoryCredentialStore(new CredentialCipher("s3cret"));
    await store.save("acme", "gemini", "sk-acme-gemini");
    expect((await store.get("acme", "openai")).status).toBe("not_found");
    expect((await store.get("bob", "gemini")).status).toBe("not_found");
  });

  it("save overwrites the previous key for the same tenant+provider", async () => {
    const store = new InMemoryCredentialStore(new CredentialCipher("s3cret"));
    await store.save("acme", "gemini", "sk-old");
    await store.save("acme", "gemini", "sk-new");
    expect(expectOk(await store.get("acme", "gemini"))).toBe("sk-new");
  });

  it("remove deletes the credential; a second remove is not_found", async () => {
    const store = new InMemoryCredentialStore(new CredentialCipher("s3cret"));
    await store.save("acme", "gemini", "sk-123");
    expect(await store.remove("acme", "gemini")).toEqual({ status: "removed" });
    expect(await store.remove("acme", "gemini")).toEqual({ status: "not_found" });
    expect((await store.get("acme", "gemini")).status).toBe("not_found");
  });
});

describe("CredentialCipher AES-256-GCM (T24)", () => {
  it("encrypts with a fresh random IV per write and a versioned encoding", () => {
    const cipher = new CredentialCipher("s3cret");
    const a = cipher.encrypt("sk-same");
    const b = cipher.encrypt("sk-same");
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(b); // random IV -> different blobs
    expect(cipher.decrypt(a)).toBe("sk-same");
    expect(cipher.decrypt(b)).toBe("sk-same");
  });

  it("round-trips unicode and empty plaintext", () => {
    const cipher = new CredentialCipher("s3cret");
    const unicode = "sk-ключ-🔑-{tenant}";
    expect(cipher.decrypt(cipher.encrypt(unicode))).toBe(unicode);
    expect(cipher.decrypt(cipher.encrypt(""))).toBe("");
  });

  it("wrong key fails loud with a clear error", () => {
    const encrypted = new CredentialCipher("key-a").encrypt("sk-123");
    expect(() => new CredentialCipher("key-b").decrypt(encrypted)).toThrow(/wrong key or tampered data/);
  });

  it("tampered payload fails loud", () => {
    const cipher = new CredentialCipher("s3cret");
    const blob = cipher.encrypt("sk-123");
    const sep = blob.indexOf(":");
    const raw = Buffer.from(blob.slice(sep + 1), "base64url");
    raw[raw.length - 1] ^= 0x01;
    const tampered = `${blob.slice(0, sep)}:${raw.toString("base64url")}`;
    expect(() => cipher.decrypt(tampered)).toThrow(/wrong key or tampered data/);
  });

  it("malformed payloads and unknown versions fail loud", () => {
    const cipher = new CredentialCipher("s3cret");
    expect(() => cipher.decrypt("garbage")).toThrow(/unsupported encoding/);
    expect(() => cipher.decrypt("v2:AAAA")).toThrow(/unsupported encoding/);
    expect(() => cipher.decrypt("v1:AAAA")).toThrow(/malformed payload/);
  });
});

describe("CredentialStore contract — pg (SQL shape, fake SqlClient)", () => {
  it("save: parameterized upsert on (tenant_id, provider); only the encrypted blob is written", async () => {
    const cipher = new CredentialCipher("s3cret");
    const db = fakeDb();
    const res = await new PgCredentialStore(db, cipher).save("acme", "gemini", "sk-123");
    expect(res).toEqual({ status: "ok" });
    const q = db.seen[0]!;
    expect(q.text).toContain("INSERT INTO provider_credentials");
    expect(q.text).toContain("ON CONFLICT (tenant_id, provider)");
    expect(q.text).toContain("enc_key = EXCLUDED.enc_key");
    expect(q.params?.[0]).toBe("acme");
    expect(q.params?.[1]).toBe("gemini");
    const blob = q.params?.[2] as string;
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("sk-123");
    expect(q.params).not.toContain("sk-123"); // plaintext never reaches the store
    expect(cipher.decrypt(blob)).toBe("sk-123");
  });

  it("get: decrypts the stored row; missing rows are not_found; store down is unavailable", async () => {
    const cipher = new CredentialCipher("s3cret");
    const db = fakeDb([{ enc_key: cipher.encrypt("sk-123") }]);
    expect(await new PgCredentialStore(db, cipher).get("acme", "gemini")).toEqual({
      status: "ok",
      providerKey: "sk-123",
    });
    const q = db.seen[0]!;
    expect(q.text).toContain("WHERE tenant_id = $1 AND provider = $2");
    expect(q.params).toEqual(["acme", "gemini"]);

    expect(await new PgCredentialStore(fakeDb([]), cipher).get("acme", "gemini")).toEqual({ status: "not_found" });

    const down = fakeDb([], {
      query: async () => {
        throw new Error("db down");
      },
    });
    const res = await new PgCredentialStore(down, cipher).get("acme", "gemini");
    expect(res).toEqual({ status: "unavailable", reason: "db down" });
  });

  it("get: a row that cannot be decrypted fails loud (no silent not_found)", async () => {
    const db = fakeDb([{ enc_key: new CredentialCipher("other-key").encrypt("sk-123") }]);
    await expect(new PgCredentialStore(db, new CredentialCipher("s3cret")).get("acme", "gemini")).rejects.toThrow(
      /wrong key or tampered data/,
    );
  });

  it("remove: DELETE ... RETURNING; zero rows is not_found; store down is unavailable", async () => {
    const db = fakeDb([{ tenant_id: "acme" }]);
    expect(await new PgCredentialStore(db, new CredentialCipher("s3cret")).remove("acme", "gemini")).toEqual({
      status: "removed",
    });
    expect(db.seen[0]!.text).toContain("DELETE FROM provider_credentials");
    expect(db.seen[0]!.text).toContain("RETURNING tenant_id");

    expect(
      await new PgCredentialStore(fakeDb([]), new CredentialCipher("s3cret")).remove("acme", "gemini"),
    ).toEqual({ status: "not_found" });

    const down = fakeDb([], {
      query: async () => {
        throw new Error("db down");
      },
    });
    expect((await new PgCredentialStore(down, new CredentialCipher("s3cret")).remove("a", "b")).status).toBe(
      "unavailable",
    );
    expect(
      (await new PgCredentialStore(down, new CredentialCipher("s3cret")).save("a", "b", "sk-1")).status,
    ).toBe("unavailable");
  });
});

describe("auth factory credentials (T24)", () => {
  it("zero-setup: in-memory credential store round-trips with the dev CRED_ENC_KEY", async () => {
    const stores = await createAuthStoresFromEnv(loadConfig({ PROVIDER: "mock" } as NodeJS.ProcessEnv));
    expect(stores.credentials.name).toBe("memory");
    expect(await stores.credentials.save("acme", "gemini", "sk-dev")).toEqual({ status: "ok" });
    expect(await stores.credentials.get("acme", "gemini")).toEqual({ status: "ok", providerKey: "sk-dev" });
    await stores.close();
    expect((await stores.credentials.get("acme", "gemini")).status).toBe("not_found");
  });
});

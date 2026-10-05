import { describe, expect, it, vi } from "vitest";
import {
  PgVectorStore,
  createPgClient,
  migrateSemanticCache,
  toVectorLiteral,
  type SqlClient,
} from "../../src/cache/PgVectorStore.js";
import { EMBEDDING_DIM } from "../../src/embeddings/EmbeddingProvider.js";

function vec(first = 1): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = first;
  return v;
}

function fakeDb(rows: any[] = [], impl: Partial<SqlClient> = {}): SqlClient & { seen: { text: string; params?: unknown[] }[] } {
  const seen: { text: string; params?: unknown[] }[] = [];
  return {
    seen,
    async query<T>(text: string, params?: unknown[]) {
      seen.push({ text, params });
      if (impl.query) return impl.query<T>(text, params);
      return { rows: rows as T[] };
    },
    async close() {},
  };
}

describe("PgVectorStore (SQL contract, no live Postgres)", () => {
  it("toVectorLiteral emits pgvector input", () => {
    expect(toVectorLiteral([1, 0.5, -2])).toBe("[1,0.5,-2]");
  });

  it("findSimilar: tenant-isolated cosine query with threshold + topK", async () => {
    const db = fakeDb([
      {
        id: "11111111-1111-1111-1111-111111111111",
        prompt_text: "hi",
        content: "hello",
        usage_prompt: 10,
        usage_completion: 5,
        temperature: 0.7,
        max_tokens: 512,
        model: "m1",
        provider: "mock",
        similarity: 0.97,
      },
    ]);
    const s = new PgVectorStore(db);
    const hits = await s.findSimilar(vec(), { tenant: "t1", provider: "mock", model: "m1" }, { threshold: 0.92, topK: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: expect.any(String), similarity: 0.97, provider: "mock" });
    const q = db.seen[0]!;
    expect(q.text).toContain("1 - (embedding <=> $1::vector)");
    expect(q.text).toContain("tenant_id = $2");
    expect(q.text).toContain("expires_at > now()");
    expect(q.params?.[1]).toBe("t1");
    expect(q.params?.[4]).toBe(0.92);
    expect(q.params?.[5]).toBe(3);
  });

  it("findSimilar: null usage maps to undefined, wrong dim short-circuits", async () => {
    const db = fakeDb([
      { id: "x", prompt_text: "p", content: "c", usage_prompt: null, usage_completion: null, temperature: 1, max_tokens: null, model: "m", provider: "p", similarity: 0.99 },
    ]);
    const s = new PgVectorStore(db);
    const hits = await s.findSimilar(vec(), { tenant: "t", provider: "p", model: "m" }, { threshold: 0, topK: 1 });
    expect(hits[0]!.usage).toBeUndefined();
    expect(hits[0]!.maxTokens).toBeUndefined();
    expect(await s.findSimilar([1, 2], { tenant: "t", provider: "p", model: "m" }, { threshold: 0, topK: 1 })).toEqual([]);
    expect(db.seen).toHaveLength(1); // short-circuit issued no SQL
  });

  it("save: upsert on (tenant, provider, model, prompt_hash) with vector cast", async () => {
    const db = fakeDb();
    const s = new PgVectorStore(db);
    await s.save({
      tenant: "t", provider: "mock", model: "m", promptHash: "h", promptText: "hi",
      temperature: 0.7, maxTokens: 100, embedding: vec(), content: "yo",
      usage: { prompt_tokens: 3, completion_tokens: 4 }, ttlSeconds: 60,
    });
    const q = db.seen[0]!;
    expect(q.text).toContain("ON CONFLICT (tenant_id, provider, model, prompt_hash)");
    expect(q.text).toContain("$8::vector");
    expect(q.params?.[3]).toBe("h");
  });

  it("save: wrong dim is a silent no-op", async () => {
    const db = fakeDb();
    await new PgVectorStore(db).save({
      tenant: "t", provider: "p", model: "m", promptHash: "h", promptText: "hi",
      temperature: 1, embedding: [1], content: "c", ttlSeconds: 60,
    });
    expect(db.seen).toHaveLength(0);
  });

  it("recordHit never throws (analytics only)", async () => {
    const db = fakeDb([], { query: async () => { throw new Error("db down"); } });
    await expect(new PgVectorStore(db).recordHit("any-id")).resolves.toBeUndefined();
  });

  it("ping is true on SELECT 1, false when the db is down", async () => {
    expect(await new PgVectorStore(fakeDb()).ping()).toBe(true);
    const down = fakeDb([], { query: async () => { throw new Error("down"); } });
    expect(await new PgVectorStore(down).ping()).toBe(false);
  });

  it("migrate: missing vector extension throws a clear, actionable error", async () => {
    const db = fakeDb([], { query: async (text: string) => { if (text.includes("CREATE EXTENSION")) throw new Error("nope"); return { rows: [] }; } });
    await expect(migrateSemanticCache(db)).rejects.toThrow(/pgvector extension missing/);
  });

  it("migrate: creates table + best-effort HNSW index", async () => {
    const db = fakeDb();
    await migrateSemanticCache(db);
    const all = db.seen.map((s) => s.text).join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS semantic_cache");
    expect(all).toContain("vector(768)");
    expect(all).toContain("hnsw");
  });

  it("createPgClient wraps pg Pool (query delegates, close ends)", async () => {
    const { Pool } = await import("pg");
    const poolProto = Pool.prototype as any;
    const qSpy = vi.spyOn(poolProto, "query").mockResolvedValue({ rows: [{ a: 1 }] } as any);
    const endSpy = vi.spyOn(poolProto, "end").mockResolvedValue(undefined as any);
    try {
      const c = createPgClient("postgres://localhost:5432/x");
      const r = await c.query("SELECT 1");
      expect((r.rows as any[])[0]).toEqual({ a: 1 });
      await c.close();
      expect(qSpy).toHaveBeenCalled();
      expect(endSpy).toHaveBeenCalled();
    } finally {
      qSpy.mockRestore();
      endSpy.mockRestore();
    }
  });
});

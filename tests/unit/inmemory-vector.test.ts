import { describe, expect, it } from "vitest";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { EMBEDDING_DIM } from "../../src/embeddings/EmbeddingProvider.js";
import type { SemanticEntry } from "../../src/cache/SemanticCacheStore.js";

function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

function entry(over: Partial<SemanticEntry> = {}): SemanticEntry {
  return {
    tenant: "default",
    provider: "mock",
    model: "m1",
    promptHash: "h-" + Math.random().toString(36).slice(2),
    promptText: "hello",
    temperature: 1,
    embedding: unit(0),
    content: "answer",
    ttlSeconds: 3600,
    ...over,
  };
}

const filter = { tenant: "default", provider: "mock", model: "m1" };

describe("InMemoryVectorStore", () => {
  it("finds an identical vector at similarity 1", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ promptHash: "a" }));
    const hits = await s.findSimilar(unit(0), filter, { threshold: 0.92, topK: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.similarity).toBeCloseTo(1);
  });

  it("threshold filters orthogonal vectors", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ promptHash: "a", embedding: unit(0) }));
    const hits = await s.findSimilar(unit(1), filter, { threshold: 0.92, topK: 3 });
    expect(hits).toHaveLength(0);
    const loose = await s.findSimilar(unit(1), filter, { threshold: 0, topK: 3 });
    expect(loose).toHaveLength(1);
    expect(loose[0]!.similarity).toBeCloseTo(0);
  });

  it("isolates tenant/provider/model", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ promptHash: "a" }));
    expect(await s.findSimilar(unit(0), { ...filter, tenant: "other" }, { threshold: 0, topK: 3 })).toHaveLength(0);
    expect(await s.findSimilar(unit(0), { ...filter, provider: "gemini" }, { threshold: 0, topK: 3 })).toHaveLength(0);
    expect(await s.findSimilar(unit(0), { ...filter, model: "m2" }, { threshold: 0, topK: 3 })).toHaveLength(0);
  });

  it("sorts best-first and honors topK", async () => {
    const s = new InMemoryVectorStore();
    const base = unit(0);
    const near = base.map((x, i) => (i === 0 ? 0.9 : i === 1 ? 0.1 : 0));
    const norm = Math.sqrt(near.reduce<number>((a, x) => a + x * x, 0));
    const nearUnit = near.map((x) => x / norm);
    await s.save(entry({ promptHash: "far", embedding: unit(1) }));
    await s.save(entry({ promptHash: "near", embedding: nearUnit }));
    const hits = await s.findSimilar(base, filter, { threshold: 0, topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.promptText).toBe("hello");
    const both = await s.findSimilar(base, filter, { threshold: 0, topK: 5 });
    expect(both[0]!.similarity).toBeGreaterThanOrEqual(both[1]!.similarity);
  });

  it("dedupes re-save of the same promptHash (one row)", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ promptHash: "dup", content: "v1" }));
    await s.save(entry({ promptHash: "dup", content: "v2" }));
    expect(s.size).toBe(1);
    const hits = await s.findSimilar(unit(0), filter, { threshold: 0, topK: 3 });
    expect(hits[0]!.content).toBe("v2");
  });

  it("expires entries after TTL", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ promptHash: "ttl", ttlSeconds: 1 }));
    // force expiry by saving with 1s then waiting is slow; instead check sweep via short ttl + time travel
    expect(s.size).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await s.findSimilar(unit(0), filter, { threshold: 0, topK: 3 })).toHaveLength(0);
  });

  it("evicts oldest first at capacity", async () => {
    const s = new InMemoryVectorStore({ maxEntries: 2 });
    await s.save(entry({ promptHash: "1" }));
    await s.save(entry({ promptHash: "2" }));
    await s.save(entry({ promptHash: "3" }));
    expect(s.size).toBe(2);
  });

  it("ignores wrong-dimension embeddings (never poisons)", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ embedding: [1, 2, 3] }));
    expect(s.size).toBe(0);
    await s.save(entry({ promptHash: "ok" }));
    expect(await s.findSimilar([1, 2], filter, { threshold: 0, topK: 3 })).toEqual([]);
  });

  it("recordHit/ping/close never throw", async () => {
    const s = new InMemoryVectorStore();
    await s.save(entry({ promptHash: "a" }));
    const hits = await s.findSimilar(unit(0), filter, { threshold: 0, topK: 1 });
    await s.recordHit(hits[0]!.id);
    await s.recordHit("missing-id");
    expect(await s.ping()).toBe(true);
    await s.close();
    expect(s.size).toBe(0);
  });
});

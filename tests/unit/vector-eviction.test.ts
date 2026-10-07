// tests/unit/vector-eviction.test.ts — memory vector-store eviction order.
//
// GPTCache-style eviction coverage for the semantic store: the capacity bound
// holds and the victim order is documented. CURRENT behavior is insertion-FIFO
// (recordHit bumps the hit counter only — it does NOT refresh recency, unlike
// InMemoryCache.get). This file locks that behavior in place; switching the
// vector store to access-ordered (LRU) eviction is an owner decision (it would
// also diverge from pgvector, which has no access-ordered eviction).

import { describe, expect, it } from "vitest";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { EMBEDDING_DIM } from "../../src/embeddings/EmbeddingProvider.js";
import type { SemanticEntry } from "../../src/cache/SemanticCacheStore.js";

function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

function entry(promptHash: string): SemanticEntry {
  return {
    tenant: "default", provider: "mock", model: "m1", promptHash,
    promptText: "hello", temperature: 1, embedding: unit(0),
    content: "answer", ttlSeconds: 3600,
  };
}

const filter = { tenant: "default", provider: "mock", model: "m1" };

describe("InMemoryVectorStore eviction order", () => {
  it("names the victim: insertion-oldest goes first regardless of hits", async () => {
    const s = new InMemoryVectorStore({ maxEntries: 2 });
    await s.save({ ...entry("a"), content: "answer-a" });
    await s.save({ ...entry("b"), content: "answer-b" });
    const hits = await s.findSimilar(unit(0), filter, { threshold: 0, topK: 3 });
    await s.recordHit(hits[0]!.id);
    await s.recordHit(hits[0]!.id);
    await s.save({ ...entry("c"), content: "answer-c" });
    const remaining = await s.findSimilar(unit(0), filter, { threshold: 0, topK: 5 });
    const contents = remaining.map((h) => h.content).sort();
    expect(contents).toEqual(["answer-b", "answer-c"]);
  });

  it("enforces the default 2000-entry bound", async () => {
    const s = new InMemoryVectorStore();
    for (let i = 0; i < 2001; i++) {
      await s.save(entry(`bulk-${i}`));
    }
    expect(s.size).toBe(2000);
  });
});

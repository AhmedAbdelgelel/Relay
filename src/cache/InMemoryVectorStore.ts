// cache/InMemoryVectorStore.ts — brute-force cosine fallback (Day 12 pattern).
// Same interface as PgVectorStore; threshold/topK/tenant semantics identical.
// No ANN index: O(n) scan, fine for dev/test. Production uses pgvector HNSW.

import { EMBEDDING_DIM } from "../embeddings/EmbeddingProvider.js";
import type {
  SemanticCacheStore,
  SemanticEntry,
  SemanticFilter,
  SemanticHit,
} from "./SemanticCacheStore.js";

interface Row extends SemanticEntry {
  id: string;
  expiresAt: number;
  hits: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

let seq = 0;

export class InMemoryVectorStore implements SemanticCacheStore {
  readonly name = "memory-vector";
  private rows: Row[] = [];
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    const m = opts.maxEntries ?? 2000;
    this.maxEntries = Number.isFinite(m) && m > 0 ? Math.floor(m) : 2000;
  }

  get size(): number {
    return this.rows.length;
  }

  private sweep(now = Date.now()): void {
    if (this.rows.some((r) => now > r.expiresAt)) {
      this.rows = this.rows.filter((r) => now <= r.expiresAt);
    }
  }

  async findSimilar(
    embedding: number[],
    filter: SemanticFilter,
    opts: { threshold: number; topK: number },
  ): Promise<SemanticHit[]> {
    this.sweep();
    if (embedding.length !== EMBEDDING_DIM) return [];
    const out: SemanticHit[] = [];
    for (const r of this.rows) {
      if (r.tenant !== filter.tenant || r.provider !== filter.provider || r.model !== filter.model) continue;
      if (r.embedding.length !== EMBEDDING_DIM) continue;
      const similarity = cosine(embedding, r.embedding);
      if (similarity >= opts.threshold) {
        out.push({
          id: r.id,
          promptText: r.promptText,
          content: r.content,
          usage: r.usage,
          temperature: r.temperature,
          maxTokens: r.maxTokens,
          model: r.model,
          provider: r.provider,
          similarity,
        });
      }
    }
    out.sort((a, b) => b.similarity - a.similarity);
    return out.slice(0, Math.max(1, opts.topK));
  }

  async save(entry: SemanticEntry): Promise<void> {
    if (entry.embedding.length !== EMBEDDING_DIM) return; // fail silent, never poison
    this.sweep();
    // One row per exact prompt (dedupes re-saves of the same answer).
    this.rows = this.rows.filter(
      (r) =>
        !(
          r.tenant === entry.tenant &&
          r.provider === entry.provider &&
          r.model === entry.model &&
          r.promptHash === entry.promptHash
        ),
    );
    while (this.rows.length >= this.maxEntries) this.rows.shift(); // oldest first
    this.rows.push({
      ...entry,
      usage: entry.usage ? { ...entry.usage } : undefined,
      embedding: [...entry.embedding],
      id: `memvec-${Date.now()}-${seq++}`,
      expiresAt: Date.now() + Math.max(1, entry.ttlSeconds) * 1000,
      hits: 0,
    });
  }

  async recordHit(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.hits++;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.rows = [];
  }
}

// Deterministic, zero-setup embedder for tests/dev.
// Same text -> identical unit vector. Different texts -> quasi-orthogonal
// vectors (similarity ~0), so paraphrases NEVER falsely match: mock semantic
// lookups are useless but always safe. Real matching needs gemini/ollama.

import { createHash } from "node:crypto";
import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

export class MockEmbedding implements EmbeddingProvider {
  readonly name = "mock";
  readonly dimension = EMBEDDING_DIM;

  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    const seed = createHash("sha256").update(text, "utf8").digest();
    // xorshift32 PRNG seeded from the hash: deterministic per text.
    let s = seed.readUInt32BE(0) || 1;
    const v = new Array<number>(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      v[i] = s / 2 ** 32 - 0.5;
    }
    // Unit-normalize so cosine similarity is a plain dot product.
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

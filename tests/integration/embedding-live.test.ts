import "dotenv/config";
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "../../src/embeddings/EmbeddingProvider.js";
import { LocalEmbedding } from "../../src/embeddings/LocalEmbedding.js";

// Real built-in-embedder test: runs the actual ONNX model. The first run
// downloads ~109 MB into ./.cache (instant where the model is already baked —
// e.g. the Docker image), so it must never run in the default `npm test`
// sweep, which stays hermetic, offline and free.
// Run with: EMBEDDING_LIVE_TEST=1 npm test
const LIVE = process.env.EMBEDDING_LIVE_TEST === "1";

const signal = new AbortController().signal;
const cos = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe.skipIf(!LIVE)("local embedding live (real ONNX model)", () => {
  const embedder = new LocalEmbedding();

  it(
    "embeds 768-d unit vectors, deterministic for identical text",
    async () => {
      const a = await embedder.embed("user: What is the capital of France?", signal);
      const b = await embedder.embed("user: What is the capital of France?", signal);
      expect(a).toHaveLength(EMBEDDING_DIM);
      expect(a).toEqual(b); // same text -> bit-identical vector
      const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 4);
    },
    600_000,
  );

  it(
    "real semantics: paraphrases land far above unrelated text",
    async () => {
      const q = await embedder.embed("user: What is the capital of France?", signal);
      const para = await embedder.embed("user: Which city is the capital of France?", signal);
      const unrelated = await embedder.embed("user: How do I bake sourdough bread?", signal);
      const simPara = cos(q, para);
      const simUnrelated = cos(q, unrelated);
      // Measured on the pinned q8 export (2026-10-16): 0.910 vs 0.183.
      expect(simPara).toBeGreaterThan(0.85);
      expect(simUnrelated).toBeLessThan(0.35);
      expect(simPara - simUnrelated).toBeGreaterThan(0.5);
    },
    600_000,
  );
});

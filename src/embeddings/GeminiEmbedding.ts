// Native Gemini embedContent REST (no SDK).
// Model default text-embedding-004 (768-d, matches EMBEDDING_DIM).
// Only place that speaks the :embedContent API.

import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

export interface GeminiEmbeddingOpts {
  apiKey: string;
  /**
   * Default "gemini-embedding-001": text-embedding-004 was RETIRED from the
   * v1beta embedContent API (live-verified 2026-10-07: ListModels reports only
   * gemini-embedding-001 / -2-preview / -2; text-embedding-004 -> 404).
   * gemini-embedding-* answers with 3072-d (or 1536-d) vectors; the EMBEDDING_DIM
   * = 768 prefix slice is the documented Matryoshka truncation, verified live:
   * paraphrase pairs land ~0.96 cosine in the 768-d slice.
   */
  model?: string;
  baseUrl?: string; // default "https://generativelanguage.googleapis.com/v1beta"
  timeoutMs?: number;
}

export class GeminiEmbedding implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimension = EMBEDDING_DIM;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: GeminiEmbeddingOpts) {
    if (!opts.apiKey) throw new Error("GEMINI_API_KEY is required for Gemini embeddings");
    this.apiKey = opts.apiKey;
    this.model = opts.model || "gemini-embedding-001";
    this.baseUrl = (opts.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async embed(text: string, signal: AbortSignal): Promise<number[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(
        `${this.baseUrl}/models/${this.model}:embedContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ model: `models/${this.model}`, content: { parts: [{ text }] } }),
        },
      );
      if (!res.ok) throw new Error(`gemini embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { embedding?: { values?: unknown } };
      const values = json.embedding?.values;
      if (!Array.isArray(values) || values.some((x) => typeof x !== "number")) {
        throw new Error("gemini embed: malformed embedding.values");
      }
      if (values.length < EMBEDDING_DIM) {
        throw new Error(`gemini embed: dim ${values.length} < ${EMBEDDING_DIM}`);
      }
      // Matryoshka: the first EMBEDDING_DIM coordinates are the trained 768-d
      // truncation of the larger embedding. Slice + re-normalize so cosine
      // comparisons stay in the unit-norm regime the stores assume.
      const sliced = (values as number[]).slice(0, EMBEDDING_DIM);
      const norm = Math.sqrt(sliced.reduce((a, x) => a + x * x, 0));
      if (norm === 0) throw new Error("gemini embed: zero-norm embedding");
      return sliced.map((x) => x / norm);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

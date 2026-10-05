// embeddings/GeminiEmbedding.ts — native Gemini embedContent REST (no SDK).
// Model default text-embedding-004 (768-d, matches EMBEDDING_DIM).
// Only place that speaks the :embedContent API.

import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

export interface GeminiEmbeddingOpts {
  apiKey: string;
  model?: string; // default "text-embedding-004"
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
    this.model = opts.model || "text-embedding-004";
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
      if (values.length !== EMBEDDING_DIM) {
        throw new Error(`gemini embed: dim ${values.length} != ${EMBEDDING_DIM}`);
      }
      return values as number[];
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

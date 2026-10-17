
import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

export interface GeminiEmbeddingOpts {
  apiKey: string;
  model?: string;
  baseUrl?: string;
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

// Local unlimited embedder (/api/embeddings).
// Default nomic-embed-text (768-d, matches EMBEDDING_DIM). Use for
// stampede/load tests to avoid burning Gemini quota.

import { EMBEDDING_DIM, type EmbeddingProvider } from "./EmbeddingProvider.js";

export interface OllamaEmbeddingOpts {
  baseUrl?: string; // default "http://localhost:11434"
  model?: string; // default "nomic-embed-text"
  timeoutMs?: number;
}

export class OllamaEmbedding implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimension = EMBEDDING_DIM;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(opts: OllamaEmbeddingOpts = {}) {
    this.baseUrl = (opts.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model || "nomic-embed-text";
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async embed(text: string, signal: AbortSignal): Promise<number[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) throw new Error(`ollama embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { embedding?: unknown };
      if (!Array.isArray(json.embedding) || json.embedding.some((x) => typeof x !== "number")) {
        throw new Error("ollama embed: malformed embedding");
      }
      if (json.embedding.length !== EMBEDDING_DIM) {
        throw new Error(`ollama embed: dim ${json.embedding.length} != ${EMBEDDING_DIM}`);
      }
      return json.embedding as number[];
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

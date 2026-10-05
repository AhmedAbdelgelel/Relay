// embeddings/factory.ts — CHOOSING: env -> embedder. Only place with `new`.

import type { GatewayConfig } from "../infrastructure/config.js";
import type { EmbeddingProvider } from "./EmbeddingProvider.js";
import { GeminiEmbedding } from "./GeminiEmbedding.js";
import { MockEmbedding } from "./MockEmbedding.js";
import { OllamaEmbedding } from "./OllamaEmbedding.js";

export function createEmbedderFromEnv(cfg: GatewayConfig): EmbeddingProvider {
  switch (cfg.embeddingProvider) {
    case "gemini":
      return new GeminiEmbedding({
        apiKey: cfg.geminiApiKey,
        model: cfg.embeddingModel || undefined,
      });
    case "ollama":
      return new OllamaEmbedding({
        baseUrl: cfg.ollamaBaseUrl.replace(/\/v1$/, ""),
        model: cfg.embeddingModel || undefined,
      });
    case "mock":
      return new MockEmbedding();
  }
}

// providers/factory.ts — CHOOSING pattern (Factory).
// Single place that maps PROVIDER env -> concrete adapter.
// api/ and server bootstrap never use `new` on a provider directly.

import type { GatewayConfig } from "../infrastructure/config.js";
import { MockProvider } from "./MockProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import type { ProviderAdapter } from "./ProviderAdapter.js";

export function createProviderFromEnv(cfg: GatewayConfig, mockOverrides?: { delayMs?: number }): ProviderAdapter {
  switch (cfg.provider) {
    case "mock":
      return new MockProvider({ delayMs: mockOverrides?.delayMs ?? 0 });
    case "gemini": {
      if (!cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is required when PROVIDER=gemini");
      return new OpenAICompatibleProvider({
        name: "gemini",
        baseURL: cfg.geminiBaseUrl,
        apiKey: cfg.geminiApiKey,
        defaultModel: cfg.geminiModel,
      });
    }
    case "ollama":
      return new OpenAICompatibleProvider({
        name: "ollama",
        baseURL: cfg.ollamaBaseUrl,
        apiKey: "",
        defaultModel: cfg.ollamaModel,
      });
    case "openai": {
      if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY is required when PROVIDER=openai");
      return new OpenAICompatibleProvider({
        name: "openai",
        baseURL: cfg.openaiBaseUrl,
        apiKey: cfg.openaiApiKey,
        defaultModel: "gpt-4o-mini",
      });
    }
  }
}

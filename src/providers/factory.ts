// providers/factory.ts — CHOOSING pattern (Factory).
// Single place that maps PROVIDER env -> concrete adapter.
// api/ and server bootstrap never use `new` on a provider directly.

import type { GatewayConfig } from "../infrastructure/config.js";
import { AnthropicAdapter } from "./AnthropicAdapter.js";
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
        defaultModel: cfg.openaiModel,
      });
    }
    case "anthropic": {
      if (!cfg.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required when PROVIDER=anthropic");
      return new AnthropicAdapter({
        name: "anthropic",
        baseURL: cfg.anthropicBaseUrl,
        apiKey: cfg.anthropicApiKey,
        defaultModel: cfg.anthropicModel,
      });
    }
  }
}

// Every configured provider, for per-model routing. mock + ollama need no key;
// gemini/openai/anthropic only when their key is present.
export function createProvidersFromEnv(cfg: GatewayConfig): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  map.set("mock", new MockProvider());
  map.set("ollama", new OpenAICompatibleProvider({
    name: "ollama",
    baseURL: cfg.ollamaBaseUrl,
    apiKey: "",
    defaultModel: cfg.ollamaModel,
  }));
  if (cfg.geminiApiKey) {
    map.set("gemini", new OpenAICompatibleProvider({
      name: "gemini",
      baseURL: cfg.geminiBaseUrl,
      apiKey: cfg.geminiApiKey,
      defaultModel: cfg.geminiModel,
    }));
  }
  if (cfg.openaiApiKey) {
    map.set("openai", new OpenAICompatibleProvider({
      name: "openai",
      baseURL: cfg.openaiBaseUrl,
      apiKey: cfg.openaiApiKey,
      defaultModel: cfg.openaiModel,
    }));
  }
  if (cfg.anthropicApiKey) {
    map.set("anthropic", new AnthropicAdapter({
      name: "anthropic",
      baseURL: cfg.anthropicBaseUrl,
      apiKey: cfg.anthropicApiKey,
      defaultModel: cfg.anthropicModel,
    }));
  }
  return map;
}

// Model-prefix routing: gpt-* -> openai, claude-* -> anthropic,
// gemini-* -> gemini, llama*/nomic* -> ollama, else fallback.
export function providerForModel(
  model: string,
  providers: Map<string, ProviderAdapter>,
  fallback: ProviderAdapter,
): ProviderAdapter {
  const m = (model || "").toLowerCase();
  const pick = (name: string): ProviderAdapter | undefined => providers.get(name);
  if (m.startsWith("gpt-")) {
    const p = pick("openai");
    if (p) return p;
  } else if (m.startsWith("claude-")) {
    const p = pick("anthropic");
    if (p) return p;
  } else if (m.startsWith("gemini-")) {
    const p = pick("gemini");
    if (p) return p;
  } else if (m.startsWith("llama") || m.startsWith("nomic")) {
    const p = pick("ollama");
    if (p) return p;
  }
  return fallback;
}


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
    case "openrouter": {
      return new OpenAICompatibleProvider({
        name: "openrouter",
        baseURL: cfg.openRouterBaseUrl,
        apiKey: cfg.openRouterKey,
        defaultModel: cfg.openRouterModel,
      });
    }
  }
}

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
  map.set("openrouter", new OpenAICompatibleProvider({
    name: "openrouter",
    baseURL: cfg.openRouterBaseUrl,
    apiKey: cfg.openRouterKey,
    defaultModel: cfg.openRouterModel,
  }));
  return map;
}

/**
 * Pure routing rule: model id → provider name, or null when no prefix/pattern
 * matches (the default provider serves those). Extracted so the chat route can
 * look up a tenant credential for the routed provider even when the operator
 * did not configure that provider from env.
 */
export function routeProviderName(model: string): string | null {
  const m = (model || "").toLowerCase();
  if (m.startsWith("gpt-")) return "openai";
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "gemini";
  if (m.startsWith("llama") || m.startsWith("nomic")) return "ollama";
  if (m.startsWith("openrouter/") || m.endsWith(":free")) return "openrouter";
  return null;
}

export function providerForModel(
  model: string,
  providers: Map<string, ProviderAdapter>,
  fallback: ProviderAdapter,
): ProviderAdapter {
  const name = routeProviderName(model);
  return (name ? providers.get(name) : undefined) ?? fallback;
}

/** Providers whose upstream rejects unauthenticated calls. */
const AUTH_PROVIDERS = new Set(["openai", "anthropic", "gemini", "openrouter"]);

export function providerRequiresKey(name: string): boolean {
  return AUTH_PROVIDERS.has(name);
}

/** The gateway's configured endpoint for a provider. */
export function defaultEndpointFor(name: string, cfg: GatewayConfig): string {
  switch (name) {
    case "gemini":
      return cfg.geminiBaseUrl;
    case "openai":
      return cfg.openaiBaseUrl;
    case "anthropic":
      return cfg.anthropicBaseUrl;
    case "ollama":
      return cfg.ollamaBaseUrl;
    case "openrouter":
      return cfg.openRouterBaseUrl;
    case "mock":
      return "in-process";
    default:
      return "";
  }
}

export function providerWithKey(
  name: string,
  apiKey: string,
  cfg: GatewayConfig,
  baseUrl?: string | null,
): ProviderAdapter {
  const url = (fallback: string): string => (baseUrl && baseUrl.trim() !== "" ? baseUrl.trim() : fallback);
  switch (name) {
    case "mock":
      return new MockProvider();
    case "gemini":
      return new OpenAICompatibleProvider({ name, baseURL: url(cfg.geminiBaseUrl), apiKey, defaultModel: cfg.geminiModel });
    case "ollama":
      return new OpenAICompatibleProvider({ name, baseURL: url(cfg.ollamaBaseUrl), apiKey: "", defaultModel: cfg.ollamaModel });
    case "openai":
      return new OpenAICompatibleProvider({ name, baseURL: url(cfg.openaiBaseUrl), apiKey, defaultModel: cfg.openaiModel });
    case "anthropic":
      return new AnthropicAdapter({ name, baseURL: url(cfg.anthropicBaseUrl), apiKey, defaultModel: cfg.anthropicModel });
    case "openrouter":
      return new OpenAICompatibleProvider({ name, baseURL: url(cfg.openRouterBaseUrl), apiKey, defaultModel: cfg.openRouterModel });
    default:
      throw new Error(`providerWithKey: unknown provider "${name}"`);
  }
}

// api/routes/providers.ts — HTTP only. Live provider status, never key values.
// Modular monolith: api owns HTTP; choosing lives in factory/server.

import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../../infrastructure/config.js";
import type { ProviderAdapter } from "../../providers/ProviderAdapter.js";

export interface ProviderStatus {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  configured: boolean;
  active: boolean;
}

const LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  ollama: "Ollama-local",
  openrouter: "OpenRouter",
  mock: "Mock",
};

export function buildProviderStatus(cfg: GatewayConfig, providers: Map<string, ProviderAdapter>): ProviderStatus[] {
  const defs: { id: string; endpoint: string; models: string[]; configured: boolean }[] = [
    { id: "openai", endpoint: cfg.openaiBaseUrl, models: [cfg.openaiModel], configured: cfg.openaiApiKey !== "" },
    { id: "anthropic", endpoint: cfg.anthropicBaseUrl, models: [cfg.anthropicModel], configured: cfg.anthropicApiKey !== "" },
    { id: "gemini", endpoint: cfg.geminiBaseUrl, models: [cfg.geminiModel], configured: cfg.geminiApiKey !== "" },
    { id: "ollama", endpoint: cfg.ollamaBaseUrl, models: [cfg.ollamaModel], configured: true },
    { id: "openrouter", endpoint: cfg.openRouterBaseUrl, models: [cfg.openRouterModel], configured: true },
    { id: "mock", endpoint: "in-process", models: ["mock"], configured: true },
  ];
  return defs.map((d) => ({
    id: d.id,
    label: LABELS[d.id] ?? d.id,
    endpoint: d.endpoint,
    models: d.models,
    // configured = key present (or no key needed). Also require the adapter to
    // exist in the map so status always reflects what routing can actually use.
    configured: d.configured && providers.has(d.id),
    active: cfg.provider === d.id,
  }));
}

export function registerProviderRoutes(
  app: FastifyInstance,
  cfg: GatewayConfig,
  providers: Map<string, ProviderAdapter>,
): void {
  app.get("/providers", async () => buildProviderStatus(cfg, providers));
}

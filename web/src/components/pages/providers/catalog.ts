import type { ProviderStatus } from "@/lib/types";

export type ProviderCatalogEntry = Omit<ProviderStatus, "configured" | "active">;

/**
 * Static catalog for the offline fallback (rough edge #15: the fallback used
 * to invent its own provider ids). These mirror the live ids and metadata:
 * labels come from src/api/routes/providers.ts, endpoints/models from the
 * defaults in src/infrastructure/config.ts — openai, anthropic, gemini,
 * ollama, openrouter, mock, in that order.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-4o-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com",
    models: ["claude-4"],
  },
  {
    id: "gemini",
    label: "Google",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.6-flash"],
  },
  {
    id: "ollama",
    label: "Ollama-local",
    endpoint: "http://localhost:11434/v1",
    models: ["llama3.1:8b"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    models: ["cohere/north-mini-code:free"],
  },
  {
    id: "mock",
    label: "Mock",
    endpoint: "in-process",
    models: ["mock"],
  },
];

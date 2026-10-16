/**
 * Playground catalog — mirrors the legacy tables in `public/js/config.js`
 * (PROVIDERS) and the playground section of `public/js/app.js` (display
 * labels, suggestions, trace steps, cache hints).
 *
 * The model list is a client-side hint only: the gateway routes by model
 * prefix regardless (gpt-* → openai, claude-* → anthropic, gemini-* → google),
 * so a live /providers catalog never blocks a manually typed model.
 */

import type { CacheVerdict } from "@/lib/types";

export interface ProviderInfo {
  label: string;
  adapter: string;
  endpoint: string;
  models: string[];
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  google: {
    label: "Google",
    adapter: "Google Adapter",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-3.6-flash", "gemini-3.5-flash-lite"],
  },
  openai: {
    label: "OpenAI",
    adapter: "OpenAI Adapter",
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  anthropic: {
    label: "Anthropic",
    adapter: "Anthropic Adapter",
    endpoint: "https://api.anthropic.com/v1",
    models: ["claude-4", "claude-4-sonnet", "claude-3.7-haiku"],
  },
  custom: {
    label: "Custom",
    adapter: "OpenAI-compatible Adapter",
    endpoint: "http://localhost:11434/v1",
    models: ["custom-model"],
  },
};

/** `<select>` order from the legacy viewPlayground() markup. */
export const PROVIDER_ORDER = ["google", "openai", "anthropic", "custom"] as const;

export const DEFAULTS = {
  provider: "google",
  model: "gemini-3.6-flash",
  temperature: 0.7,
  maxTokens: 512,
  stream: true,
} as const;

/** The 3 legacy suggestion chips (same texts, inventory §2.2). */
export const SUGGESTIONS = [
  "What does an exact cache guarantee?",
  "Explain canonical request hashing",
  "Why does stream:true bypass the cache?",
] as const;

/**
 * Assistant display name (legacy providerLabel(): google → Gemini).
 * Unknown ids (e.g. the test mock adapter) are shown verbatim — never
 * invented — so evidence stays honest.
 */
export function providerDisplayLabel(provider: string | null | undefined): string {
  if (!provider) return "Assistant";
  if (provider === "google") return "Gemini";
  return PROVIDERS[provider]?.label ?? provider;
}

/** Head pill text (legacy populateModels() labels). */
export function providerPillLabel(provider: string): string {
  switch (provider) {
    case "google":
      return "Google · Gemini";
    case "openai":
      return "OpenAI · GPT";
    case "anthropic":
      return "Anthropic · Claude";
    case "custom":
      return "Custom";
    default:
      return provider;
  }
}

/** The 8 trace steps (config.js TRACE_STEPS), indexed 0–7. */
export const TRACE_STEPS = [
  "Client",
  "Gateway",
  "Canonical Request",
  "Provider Router",
  "Provider Adapter",
  "LLM Provider",
  "Canonical Response",
  "Client",
] as const;

/** Static verdict hints (legacy CACHE_HINT, extended with SEMANTIC_HIT). */
const CACHE_HINT: Record<CacheVerdict, string> = {
  HIT: "Exact match found for this canonical key — served from cache, the provider was NOT called.",
  SEMANTIC_HIT:
    "Paraphrase matched a stored question — the answer was reused and the provider was NOT called.",
  MISS: "No entry for this key — provider called, response stored under the key for the TTL.",
  BYPASS: "stream:true bypasses the exact cache (an SSE stream cannot replay a stored blob).",
  DISABLED: "Cache turned off on this gateway (CACHE_ENABLED=0) — every request reaches the provider.",
};

/** Human hint for every verdict; SEMANTIC_HIT cites the measured similarity. */
export function cacheHint(verdict: CacheVerdict | null, similarity?: number | null): string {
  if (!verdict) return "not classified (request failed)";
  if (verdict === "SEMANTIC_HIT") {
    const s =
      typeof similarity === "number" && Number.isFinite(similarity)
        ? ` with similarity ${similarity.toFixed(4)}`
        : "";
    return `Paraphrase matched a stored question${s} — the answer was reused and the provider was NOT called.`;
  }
  return CACHE_HINT[verdict];
}

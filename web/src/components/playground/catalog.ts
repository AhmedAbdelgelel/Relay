/**
 * Playground catalog — mirrors the legacy tables in `public/js/config.js`
 * (PROVIDERS) and the playground section of `public/js/app.js` (display
 * labels, suggestions, trace steps, cache hints).
 *
 * The model list is a client-side hint only: the gateway routes by model
 * prefix regardless (gpt-* → openai, claude-* → anthropic, gemini-* → google,
 * *:free / openrouter/* → openrouter), so a live /providers catalog never
 * blocks a manually typed model. The openrouter entry lists the $0 free tier
 * fetched from https://openrouter.ai/api/v1/models (2026-10-18).
 */

import type { CacheVerdict, Lane } from "@/lib/types";

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
  openrouter: {
    label: "OpenRouter",
    adapter: "OpenAI-compatible Adapter",
    endpoint: "https://openrouter.ai/api/v1",
    // Curated `$0` tier. Free ids churn and each upstream rate-limits/retires
    // independently of OpenRouter, so the bundled list only carries models
    // verified against the live free tier on 2026-10-26. "Refresh" pulls the
    // live public $0 list; the custom-id field accepts any model id.
    models: [
      "cohere/north-mini-code:free",
      "xingchen-agi/xing4.0-29b-a4b:free",
      "liquid/lfm-2.5-2.6b:free",
      "recursive/flint-v1.0:free",
    ],
  },
  custom: {
    label: "Custom",
    adapter: "OpenAI-compatible Adapter",
    endpoint: "http://localhost:11434/v1",
    models: ["custom-model"],
  },
  /** Zero-setup default (`PROVIDER=mock`): in-process, no keys, no network. */
  mock: {
    label: "Mock",
    adapter: "In-process Mock Adapter",
    endpoint: "in-process",
    models: ["mock"],
  },
};

/** Legacy `<select>` order plus `mock`, the gateway's zero-setup default provider. */
export const PROVIDER_ORDER = [
  "mock",
  "google",
  "openai",
  "anthropic",
  "openrouter",
  "custom",
] as const;

/** Free OpenRouter tier: `:free` suffixed ids route to OpenRouter and bill $0. */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free");
}

/**
 * Client mirror of the gateway's providerForModel() (src/providers/factory.ts),
 * used for display only — the gateway resolves the real provider per request.
 * `fallback` maps the gateway's default provider id to a catalog id.
 */
export function providerForModel(model: string, fallback = "google"): string {
  const m = (model || "").toLowerCase();
  if (m.startsWith("gpt-")) return "openai";
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "google";
  if (m.startsWith("llama") || m.startsWith("nomic")) return "custom";
  if (m.startsWith("openrouter/") || m.endsWith(":free")) return "openrouter";
  return fallback;
}

/** Map a gateway provider id (health.provider) to a catalog id for display. */
export function catalogProviderId(providerId: string | null | undefined): string {
  switch (providerId) {
    case "gemini":
      return "google";
    case "ollama":
      return "custom";
    case "openai":
    case "anthropic":
    case "openrouter":
    case "mock":
      return providerId;
    default:
      return "google";
  }
}

export const DEFAULTS = {
  // The gateway's zero-setup default (`PROVIDER=mock`): a fresh checkout must be
  // able to send immediately. PlaygroundPage swaps in the active provider's first
  // model from GET /providers for gateways configured with a real default.
  model: "mock",
  // Streams bypass both cache layers by design (an SSE response cannot replay a
  // stored blob), so the simple caching story starts with cacheable requests.
  // Token streaming is one switch away when a user wants it.
  stream: false,
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
  if (provider === "google" || provider === "gemini") return "Gemini";
  if (provider === "ollama") return "Ollama";
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
    case "openrouter":
      return "OpenRouter";
    case "mock":
      return "Mock";
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

/**
 * Human hint for every verdict; SEMANTIC_HIT cites the measured similarity.
 * An anonymous-lane BYPASS gets its own hint: the try-out lane never caches,
 * regardless of the stream flag (the stream hint stays for registered keys).
 */
export function cacheHint(
  verdict: CacheVerdict | null,
  similarity?: number | null,
  lane?: Lane | null,
): string {
  if (!verdict) return "not classified (request failed)";
  if (verdict === "BYPASS" && lane === "anonymous") {
    return "anonymous try-out lane — always bypasses the cache; paste a registered lg_… key to enable caching.";
  }
  if (verdict === "SEMANTIC_HIT") {
    const s =
      typeof similarity === "number" && Number.isFinite(similarity)
        ? ` with similarity ${similarity.toFixed(4)}`
        : "";
    return `Paraphrase matched a stored question${s} — the answer was reused and the provider was NOT called.`;
  }
  return CACHE_HINT[verdict];
}

/**
 * Actionable copy for a failed `$0` OpenRouter request. Free models churn and
 * upstreams rate-limit or retire independently of OpenRouter: a `:free` id can
 * answer 404 (`provider_not_found`) or 429 (`provider_rate_limited`) while the
 * account and gateway are healthy. Point the user at verified free models
 * instead of leaving a raw provider snippet as the only explanation.
 */
export function freeModelFailureHint(model: string, code: string | null | undefined): string | null {
  if (!isFreeModel(model)) return null;
  if (code !== "provider_not_found" && code !== "provider_rate_limited" && code !== "provider_error") {
    return null;
  }
  const reason = code === "provider_rate_limited" ? "is temporarily rate-limited upstream" : "is unavailable upstream right now";
  return `This $0 model ${reason}. Pick another $0 model — cohere/north-mini-code:free and xingchen-agi/xing4.0-29b-a4b:free are verified working here — or press Retry.`;
}

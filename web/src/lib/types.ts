/**
 * Shared types for the Relay control-plane UI.
 *
 * Field names mirror the gateway contract exactly (see agent/ui-inventory.md
 * §1): /health, /metrics, /providers, chat evidence headers and SSE frames.
 */

export type CacheVerdict = "HIT" | "SEMANTIC_HIT" | "MISS" | "DISABLED" | "BYPASS";
export type Lane = "registered" | "anonymous";

/** GET /v1/usage — the caller tenant slice only (registered lane). Field names
 * mirror the gateway payload exactly (runbook errors corrected from the wire:
 * `avg_latency_ms`, plus `coalesced`/`latency_ms_total` the runbook omitted). */
export interface TenantUsage {
  tenant: string;
  requests: number;
  exact_hits: number;
  semantic_hits: number;
  misses: number;
  coalesced: number;
  hit_rate: number;
  provider_calls_avoided: number;
  latency_ms_total: number;
  avg_latency_ms: number;
}

/** POST /v1/register — 201 payload; the key is shown to the caller exactly once. */
export interface RegisterResult {
  tenant_id: string;
  provider: string;
  key: string;
  key_prefix: string;
}

/** Connection to a gateway. Empty `baseUrl` = same origin (the Next rewrites). */
export interface Connection {
  baseUrl: string;
  apiKey: string;
}

/** `config` object served by GET /health. */
export interface GatewayConfig {
  cacheEnabled: boolean;
  cacheTtlSec: number;
  semanticEnabled: boolean;
  semanticThreshold: number;
  semanticTopK: number;
  semanticTtlSec: number;
  upstreamTimeoutMs: number;
}

/** GET /health */
export interface HealthInfo {
  ok: boolean;
  provider: string;
  cache: string;
  semantic: string;
  embedder: string;
  config?: GatewayConfig;
}

/** GET /metrics — mirrors src/observability/metrics.ts MetricsSnapshot. */
export interface MetricsSnapshot {
  requests_total: number;
  exact_hits: number;
  exact_misses: number;
  singleflight_coalesced: number;
  singleflight_leaders: number;
  provider_requests: number;
  provider_errors: number;
  cache_lookup_failed: number;
  cache_write_failed: number;
  semantic_hits: number;
  semantic_misses: number;
  semantic_errors: number;
  fallback_count: number;
  breaker_open: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_saved: number;
  semantic_hist_lt_090: number;
  semantic_hist_090_092: number;
  semantic_hist_092_095: number;
  semantic_hist_gte_095: number;
  auth_rejects_total: number;
  semantic_lookups: number;
  avg_semantic_score: number;
  cache_lookups: number;
  cache_latency_ms_total: number;
  avg_cache_lookup_ms: number;
  provider_latency_ms_total: number;
  avg_provider_ms: number;
  hit_rate: number;
  provider_calls_avoided: number;
}

/** Honest zeros for a cold gateway — never fabricate traffic. */
export const EMPTY_METRICS: MetricsSnapshot = {
  requests_total: 0,
  exact_hits: 0,
  exact_misses: 0,
  singleflight_coalesced: 0,
  singleflight_leaders: 0,
  provider_requests: 0,
  provider_errors: 0,
  cache_lookup_failed: 0,
  cache_write_failed: 0,
  semantic_hits: 0,
  semantic_misses: 0,
  semantic_errors: 0,
  fallback_count: 0,
  breaker_open: 0,
  tokens_in: 0,
  tokens_out: 0,
  estimated_cost_saved: 0,
  semantic_hist_lt_090: 0,
  semantic_hist_090_092: 0,
  semantic_hist_092_095: 0,
  semantic_hist_gte_095: 0,
  auth_rejects_total: 0,
  semantic_lookups: 0,
  avg_semantic_score: 0,
  cache_lookups: 0,
  cache_latency_ms_total: 0,
  avg_cache_lookup_ms: 0,
  provider_latency_ms_total: 0,
  avg_provider_ms: 0,
  hit_rate: 0,
  provider_calls_avoided: 0,
};

/** GET /providers */
export interface ProviderStatus {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  configured: boolean;
  active: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

/** OpenAI-shaped chat request body built by lib/canonical.ts. */
export interface ChatPayloadMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatPayload {
  model: string;
  messages: ChatPayloadMessage[];
  temperature: number;
  stream: boolean;
  max_tokens?: number;
}

/** Minimal OpenAI-shaped response (JSON mode) / SSE frame shape. */
export interface ChatCompletionChoice {
  index?: number;
  message?: { role?: string; content?: string | null };
  delta?: { role?: string; content?: string | null };
  finish_reason?: string | null;
}

export interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: Usage;
}

/**
 * Evidence headers attached to every validated reply (inventory §1).
 * Absent headers are `null`; stream TTFT arrives as `x-latency-ms`.
 */
export interface Evidence {
  requestId: string | null;
  lane: Lane | null;
  keyId?: string | null;
  provider: string | null;
  cache: CacheVerdict | null;
  cacheHash: string | null;
  latencyMs: number | null;
  ttftMs?: number | null;
  coalesced?: boolean | null;
  semanticSimilarity?: number | null;
  fallback?: boolean | null;
  usage?: Usage | null;
}

/** One SSE content delta: `delta` chunk, accumulated `text`, running count. */
export interface StreamChunk {
  delta: string;
  text: string;
  chunks: number;
}

/** Metrics card metadata kept on assistant messages (inventory §2.2). */
export interface MessageMeta {
  verdict: CacheVerdict | null;
  provider: string | null;
  model: string;
  latencyMs: number | null;
  ttftMs?: number;
  chunks?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimated?: boolean;
  cacheHash?: string;
  canonical?: string;
  requestId: string;
  /** ISO timestamp. */
  at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  kind: "normal" | "error" | "notice";
  text: string;
  meta?: MessageMeta;
  /**
   * Full reply evidence (lane, key id, coalescing, fallback, similarity).
   * Stored on the message so it persists with the chat and the evidence card
   * survives a reload — the page-local map alone lost these rows.
   */
  evidence?: Evidence;
}

export interface ChatRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** ISO timestamp; chats are sorted by most recently updated. */
  updatedAt: string;
}

/** In-memory capture of the last exchange, for the Requests inspector. */
export interface LastIO {
  payload: ChatPayload;
  canonical: string;
  evidence: Evidence;
  usage?: Usage | null;
  text: string;
  mode: "json" | "stream";
  error?: string;
}

/**
 * Browser-session counters. `estimated` flags totals that include a ≈
 * client-side token estimate because the provider reported no usage.
 */
export interface SessionStats {
  requests: number;
  /** HIT + SEMANTIC_HIT (both avoided a provider call). */
  hits: number;
  semanticHits: number;
  misses: number;
  bypassed: number;
  disabled: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  reusedTokens: number;
  chunks: number;
  latencyMsTotal: number;
  ttftMsTotal: number;
  ttftCount: number;
  estimated: boolean;
}

export const EMPTY_STATS: SessionStats = {
  requests: 0,
  hits: 0,
  semanticHits: 0,
  misses: 0,
  bypassed: 0,
  disabled: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  reusedTokens: 0,
  chunks: 0,
  latencyMsTotal: 0,
  ttftMsTotal: 0,
  ttftCount: 0,
  estimated: false,
};

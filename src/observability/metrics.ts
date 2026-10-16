// Minimal in-memory cache/provider metrics.
// This singleton backs GET /metrics (JSON)
// and the log lines. All methods are sync and never throw.

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
  /** T27/R1: every auth rejection (guard 401/403/503, provider mismatch, usage anonymous). */
  auth_rejects_total: number;
  semantic_lookups: number;
  avg_semantic_score: number;
  cache_lookups: number;
  cache_latency_ms_total: number;
  avg_cache_lookup_ms: number;
  provider_latency_ms_total: number;
  avg_provider_ms: number;
  hit_rate: number;
  /** hits + coalesced followers that avoided a second provider call */
  provider_calls_avoided: number;
}

/**
 * Per-tenant slice for the REGISTERED lane (T26). Deliberately not part of
 * MetricsSnapshot: GET /metrics is public, so tenant usage is only readable
 * via tenantSnapshot(tenant) (T27's /v1/usage is the sanctioned reader).
 * Derived fields: `misses` = requests - exact_hits - semantic_hits (i.e. not
 * served by either cache); `provider_calls_avoided` = exact_hits +
 * semantic_hits + coalesced.
 */
export interface TenantUsageSnapshot {
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

interface TenantUsage {
  requests: number;
  exact_hits: number;
  semantic_hits: number;
  coalesced: number;
  latency_ms_total: number;
  latency_samples: number;
}

const ZERO: MetricsSnapshot = {
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

export type CounterName =
  | "requests_total"
  | "exact_hits"
  | "exact_misses"
  | "singleflight_coalesced"
  | "singleflight_leaders"
  | "provider_requests"
  | "provider_errors"
  | "cache_lookup_failed"
  | "cache_write_failed"
  | "semantic_hits"
  | "semantic_misses"
  | "semantic_errors"
  | "fallback_count"
  | "breaker_open"
  | "tokens_in"
  | "tokens_out"
  | "estimated_cost_saved"
  | "semantic_hist_lt_090"
  | "semantic_hist_090_092"
  | "semantic_hist_092_095"
  | "semantic_hist_gte_095"
  | "auth_rejects_total";

export class GatewayMetrics {
  private c: Record<CounterName, number> = {
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
  };
  private cacheLookups = 0;
  private cacheLatencyTotal = 0;
  private providerLatencyTotal = 0;
  private semanticScoreTotal = 0;
  private semanticScored = 0;
  /** tenant -> usage; registered lane only. Read via tenantSnapshot(). */
  private readonly tenants = new Map<string, TenantUsage>();

  inc(name: CounterName, by = 1): void {
    this.c[name] += by;
  }

  observeCacheLookup(ms: number): void {
    this.cacheLookups++;
    this.cacheLatencyTotal += Math.max(0, ms);
  }

  observeProviderLatency(ms: number): void {
    this.providerLatencyTotal += Math.max(0, ms);
  }

  observeSemanticScore(similarity: number): void {
    this.semanticScoreTotal += similarity;
    this.semanticScored++;
    if (!(similarity >= 0)) return;
    if (similarity < 0.9) this.c.semantic_hist_lt_090++;
    else if (similarity < 0.92) this.c.semantic_hist_090_092++;
    else if (similarity < 0.95) this.c.semantic_hist_092_095++;
    else this.c.semantic_hist_gte_095++;
  }

  observeTokens(promptTokens: number, completionTokens: number): void {
    if (promptTokens > 0) this.c.tokens_in += Math.floor(promptTokens);
    if (completionTokens > 0) this.c.tokens_out += Math.floor(completionTokens);
  }

  observeSaved(promptTokens: number, completionTokens: number, usdPer1kTokens: number): void {
    if (usdPer1kTokens <= 0) return;
    const tokens = Math.max(0, Math.floor(promptTokens)) + Math.max(0, Math.floor(completionTokens));
    this.c.estimated_cost_saved += (tokens / 1000) * usdPer1kTokens;
  }

  // --- T26 registered-lane per-tenant recording (anonymous lanes never call
  // these). Same sites as the global counters; sync and never throw.

  observeTenantRequest(tenant: string): void {
    this.tenant(tenant).requests++;
  }

  observeTenantExactHit(tenant: string): void {
    this.tenant(tenant).exact_hits++;
  }

  observeTenantSemanticHit(tenant: string): void {
    this.tenant(tenant).semantic_hits++;
  }

  observeTenantCoalesced(tenant: string): void {
    this.tenant(tenant).coalesced++;
  }

  /** Terminal-outcome latency (hit / semantic hit / served miss / stream done). */
  observeTenantLatency(tenant: string, ms: number): void {
    const t = this.tenant(tenant);
    t.latency_ms_total += Math.max(0, ms);
    t.latency_samples++;
  }

  /** One tenant's slice only — never the whole tenant map. Unknown tenant = zeros. */
  tenantSnapshot(tenant: string): TenantUsageSnapshot {
    const t = this.tenants.get(tenant);
    const requests = t?.requests ?? 0;
    const exactHits = t?.exact_hits ?? 0;
    const semanticHits = t?.semantic_hits ?? 0;
    const coalesced = t?.coalesced ?? 0;
    const latencyTotal = t?.latency_ms_total ?? 0;
    const samples = t?.latency_samples ?? 0;
    return {
      tenant,
      requests,
      exact_hits: exactHits,
      semantic_hits: semanticHits,
      misses: Math.max(0, requests - exactHits - semanticHits),
      coalesced,
      hit_rate: requests > 0 ? (exactHits + semanticHits) / requests : 0,
      provider_calls_avoided: exactHits + semanticHits + coalesced,
      latency_ms_total: latencyTotal,
      avg_latency_ms: samples > 0 ? latencyTotal / samples : 0,
    };
  }

  private tenant(tenant: string): TenantUsage {
    let t = this.tenants.get(tenant);
    if (!t) {
      t = { requests: 0, exact_hits: 0, semantic_hits: 0, coalesced: 0, latency_ms_total: 0, latency_samples: 0 };
      this.tenants.set(tenant, t);
    }
    return t;
  }

  snapshot(): MetricsSnapshot {
    const hits = this.c.exact_hits;
    const misses = this.c.exact_misses;
    const denom = hits + misses;
    return {
      ...this.c,
      semantic_lookups: this.c.semantic_hits + this.c.semantic_misses,
      avg_semantic_score: this.semanticScored > 0 ? this.semanticScoreTotal / this.semanticScored : 0,
      cache_lookups: this.cacheLookups,
      cache_latency_ms_total: this.cacheLatencyTotal,
      avg_cache_lookup_ms: this.cacheLookups > 0 ? this.cacheLatencyTotal / this.cacheLookups : 0,
      provider_latency_ms_total: this.providerLatencyTotal,
      avg_provider_ms:
        this.c.provider_requests > 0 ? this.providerLatencyTotal / this.c.provider_requests : 0,
      hit_rate: denom > 0 ? hits / denom : 0,
      provider_calls_avoided: hits + this.c.singleflight_coalesced,
    };
  }

  reset(): void {
    for (const k of Object.keys(this.c) as CounterName[]) this.c[k] = 0;
    this.cacheLookups = 0;
    this.cacheLatencyTotal = 0;
    this.providerLatencyTotal = 0;
    this.semanticScoreTotal = 0;
    this.semanticScored = 0;
    this.tenants.clear();
  }
}

/** Process-wide singleton used by routes. Tests must call metrics.reset(). */
export const metrics = new GatewayMetrics();

export const __zeroSnapshotForTests = ZERO;

// observability/metrics.ts — Day 13: minimal in-memory cache/provider metrics.
// Week 6 adds Prometheus; until then this singleton backs GET /metrics (JSON)
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
  | "semantic_errors";

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
  };
  private cacheLookups = 0;
  private cacheLatencyTotal = 0;
  private providerLatencyTotal = 0;
  private semanticScoreTotal = 0;
  private semanticScored = 0;

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
  }
}

/** Process-wide singleton used by routes. Tests must call metrics.reset(). */
export const metrics = new GatewayMetrics();

export const __zeroSnapshotForTests = ZERO;

import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "../../src/observability/metrics.js";

describe("GatewayMetrics (Day 13 unit)", () => {
  it("counts hits/misses and derives hit_rate + avoided", () => {
    const m = new GatewayMetrics();
    m.inc("requests_total", 4);
    m.inc("exact_hits", 3);
    m.inc("exact_misses", 1);
    m.inc("singleflight_coalesced", 2);
    const s = m.snapshot();
    expect(s.hit_rate).toBeCloseTo(0.75);
    expect(s.provider_calls_avoided).toBe(5); // 3 hits + 2 coalesced
    expect(s.requests_total).toBe(4);
  });

  it("averages latencies and handles zero division", () => {
    const m = new GatewayMetrics();
    expect(m.snapshot().avg_cache_lookup_ms).toBe(0);
    expect(m.snapshot().hit_rate).toBe(0);
    m.observeCacheLookup(10);
    m.observeCacheLookup(30);
    m.inc("provider_requests", 2);
    m.observeProviderLatency(100);
    const s = m.snapshot();
    expect(s.avg_cache_lookup_ms).toBe(20);
    expect(s.avg_provider_ms).toBe(50);
  });

  it("reset clears everything", () => {
    const m = new GatewayMetrics();
    m.inc("exact_hits");
    m.observeCacheLookup(5);
    m.reset();
    const s = m.snapshot();
    expect(s.exact_hits).toBe(0);
    expect(s.cache_lookups).toBe(0);
    expect(s.hit_rate).toBe(0);
  });
});

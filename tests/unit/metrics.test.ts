import { describe, expect, it } from "vitest";
import { GatewayMetrics } from "../../src/observability/metrics.js";

describe("GatewayMetrics", () => {
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

  it("tenant snapshots are derived, isolated, and absent from the public snapshot", () => {
    const m = new GatewayMetrics();
    m.observeTenantRequest("t-a");
    m.observeTenantRequest("t-a");
    m.observeTenantRequest("t-a");
    m.observeTenantRequest("t-a");
    m.observeTenantExactHit("t-a");
    m.observeTenantExactHit("t-a");
    m.observeTenantSemanticHit("t-a");
    m.observeTenantCoalesced("t-a");
    m.observeTenantLatency("t-a", 10);
    m.observeTenantLatency("t-a", 30);
    expect(m.tenantSnapshot("t-a")).toEqual({
      tenant: "t-a",
      requests: 4,
      exact_hits: 2,
      semantic_hits: 1,
      misses: 1, // 4 requests - 2 exact - 1 semantic
      coalesced: 1,
      hit_rate: 0.75, // (2 + 1) / 4
      provider_calls_avoided: 4, // 2 exact + 1 semantic + 1 coalesced
      latency_ms_total: 40,
      avg_latency_ms: 20,
    });
    // Untouched tenants read as documented zeros; reads never create rows.
    expect(m.tenantSnapshot("t-b").requests).toBe(0);
    expect(m.tenantSnapshot("t-b").hit_rate).toBe(0);
    expect(m.tenantSnapshot("t-b").misses).toBe(0);
    expect(m.tenantSnapshot("t-a").requests).toBe(4);
    // The public snapshot (GET /metrics) must never leak the tenant map.
    expect(JSON.stringify(m.snapshot())).not.toContain("t-a");
  });

  it("reset clears tenant usage too", () => {
    const m = new GatewayMetrics();
    m.observeTenantRequest("t-a");
    m.observeTenantExactHit("t-a");
    m.observeTenantLatency("t-a", 5);
    m.reset();
    const a = m.tenantSnapshot("t-a");
    expect(a.requests).toBe(0);
    expect(a.exact_hits).toBe(0);
    expect(a.latency_ms_total).toBe(0);
  });
});

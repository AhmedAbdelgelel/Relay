/**
 * Session stats classification (lib/store): the pure `applyStats` fold plus a
 * store-level probe proving `recordStats` wires through AppProvider. Covers
 * the legacy verdict bug fix: HIT + SEMANTIC_HIT both count as hits and reuse
 * tokens; DISABLED/BYPASS have their own buckets; errors never hide a verdict.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppProvider,
  applyStats,
  sessionDecided,
  sessionHitRate,
  sessionTotalTokens,
  useAppStore,
} from "@/lib/store";
import { EMPTY_STATS, type Evidence, type SessionStats } from "@/lib/types";
import { installFetch } from "@/test/helpers";

function evidence(verdict: Evidence["cache"], extra: Partial<Evidence> = {}): Evidence {
  return {
    requestId: "req-1",
    lane: "registered",
    provider: "mock",
    cache: verdict,
    cacheHash: null,
    latencyMs: 10,
    ...extra,
  };
}

function fold(input: Parameters<typeof applyStats>[1]): SessionStats {
  return applyStats(EMPTY_STATS, input);
}

describe("applyStats verdict classification", () => {
  it("HIT: counts as hit and reuses prompt + completion tokens", () => {
    const next = fold({
      evidence: evidence("HIT"),
      tokens: { promptTokens: 10, completionTokens: 20 },
      latencyMs: 120,
      options: {},
    });

    expect(next.requests).toBe(1);
    expect(next.hits).toBe(1);
    expect(next.semanticHits).toBe(0);
    expect(next.reusedTokens).toBe(30);
    expect(next.misses).toBe(0);
    expect(next.bypassed).toBe(0);
    expect(next.disabled).toBe(0);
    expect(next.latencyMsTotal).toBe(120);
  });

  it("SEMANTIC_HIT: counts as hit + semanticHits and reuses tokens", () => {
    const next = fold({
      evidence: evidence("SEMANTIC_HIT", { semanticSimilarity: 0.97 }),
      tokens: { promptTokens: 4, completionTokens: 6 },
      latencyMs: null,
      options: {},
    });

    expect(next.hits).toBe(1);
    expect(next.semanticHits).toBe(1);
    expect(next.reusedTokens).toBe(10);
    expect(next.requests).toBe(1);
  });

  it("MISS: provider was called, nothing reused", () => {
    const next = fold({
      evidence: evidence("MISS"),
      tokens: { promptTokens: 7, completionTokens: 3 },
      latencyMs: 900,
      options: {},
    });

    expect(next.hits).toBe(0);
    expect(next.misses).toBe(1);
    expect(next.reusedTokens).toBe(0);
    expect(next.promptTokens).toBe(7);
    expect(next.completionTokens).toBe(3);
  });

  it("DISABLED: own bucket, still counts tokens", () => {
    const next = fold({
      evidence: evidence("DISABLED"),
      tokens: { promptTokens: 5, completionTokens: 5 },
      latencyMs: 50,
      options: {},
    });

    expect(next.disabled).toBe(1);
    expect(next.hits).toBe(0);
    expect(next.misses).toBe(0);
    expect(next.bypassed).toBe(0);
  });

  it("BYPASS: stream bypass bucket", () => {
    const next = fold({
      evidence: evidence("BYPASS"),
      tokens: null,
      latencyMs: 10,
      options: { chunks: 42, ttftMs: 8 },
    });

    expect(next.bypassed).toBe(1);
    expect(next.chunks).toBe(42);
    expect(next.ttftMsTotal).toBe(8);
    expect(next.ttftCount).toBe(1);
  });

  it("unclassified evidence (null / missing verdict) falls into bypassed", () => {
    const withNullEvidence = fold({ evidence: null, tokens: null, latencyMs: null, options: {} });
    const withNullVerdict = fold({
      evidence: evidence(null),
      tokens: null,
      latencyMs: null,
      options: {},
    });

    expect(withNullEvidence.bypassed).toBe(1);
    expect(withNullVerdict.bypassed).toBe(1);
    expect(withNullVerdict.hits).toBe(0);
  });

  it("errors are counted separately and never hide the verdict", () => {
    const next = fold({
      evidence: evidence("MISS"),
      tokens: null,
      latencyMs: 20,
      options: { error: "aborted" },
    });

    expect(next.errors).toBe(1);
    expect(next.misses).toBe(1);
  });

  it("accumulates latency (clamped at 0), ttft, chunks and the estimated flag", () => {
    const first = applyStats(EMPTY_STATS, {
      evidence: evidence("MISS"),
      tokens: { promptTokens: 3, completionTokens: 1, estimated: true },
      latencyMs: -5,
      options: { ttftMs: 12.5, chunks: 4 },
    });
    const next = applyStats(first, {
      evidence: evidence("MISS"),
      tokens: null,
      latencyMs: 100,
      options: { chunks: 2 },
    });

    expect(next.latencyMsTotal).toBe(100);
    expect(next.ttftMsTotal).toBe(12.5);
    expect(next.ttftCount).toBe(1);
    expect(next.chunks).toBe(6);
    expect(next.estimated).toBe(true);
    expect(next.promptTokens).toBe(3);
    expect(next.completionTokens).toBe(1);
  });
});

describe("session stat helpers", () => {
  it("derive decided count, hit rate and total tokens", () => {
    const stats: SessionStats = {
      ...EMPTY_STATS,
      hits: 3,
      misses: 1,
      promptTokens: 40,
      completionTokens: 60,
    };

    expect(sessionDecided(stats)).toBe(4);
    expect(sessionHitRate(stats)).toBeCloseTo(0.75);
    expect(sessionTotalTokens(stats)).toBe(100);
    expect(sessionHitRate(EMPTY_STATS)).toBeNull();
    expect(sessionDecided(EMPTY_STATS)).toBe(0);
  });
});

/* ── store-level probe: recordStats through AppProvider ──────────────────── */

function StatsProbe() {
  const { stats, recordStats } = useAppStore();

  return (
    <div>
      <span data-testid="requests">{stats.requests}</span>
      <span data-testid="hits">{stats.hits}</span>
      <span data-testid="semantic-hits">{stats.semanticHits}</span>
      <span data-testid="reused">{stats.reusedTokens}</span>
      <span data-testid="bypassed">{stats.bypassed}</span>
      <span data-testid="errors">{stats.errors}</span>
      <button
        type="button"
        onClick={() =>
          recordStats(
            evidence("SEMANTIC_HIT", { semanticSimilarity: 0.94 }),
            { promptTokens: 4, completionTokens: 6 },
            20,
          )
        }
      >
        record semantic hit
      </button>
      <button type="button" onClick={() => recordStats(null, null, null, { error: "aborted" })}>
        record abort
      </button>
    </div>
  );
}

describe("AppProvider.recordStats", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installFetch([]); // background /health + /metrics pollers stay pending forever
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("folds recorded traffic into the session counters", () => {
    render(
      <AppProvider>
        <StatsProbe />
      </AppProvider>,
    );

    expect(screen.getByTestId("requests")).toHaveTextContent("0");

    fireEvent.click(screen.getByRole("button", { name: "record semantic hit" }));
    expect(screen.getByTestId("requests")).toHaveTextContent("1");
    expect(screen.getByTestId("hits")).toHaveTextContent("1");
    expect(screen.getByTestId("semantic-hits")).toHaveTextContent("1");
    expect(screen.getByTestId("reused")).toHaveTextContent("10");

    fireEvent.click(screen.getByRole("button", { name: "record abort" }));
    expect(screen.getByTestId("requests")).toHaveTextContent("2");
    expect(screen.getByTestId("errors")).toHaveTextContent("1");
    // null evidence has no verdict, so it lands in the bypass bucket
    // (never silently hidden by the error count).
    expect(screen.getByTestId("bypassed")).toHaveTextContent("1");
  });
});

/**
 * Display formatting helpers — deterministic en-US output only.
 * Timing-sensitive formatting is pure, so no fake timers are needed here.
 */

import { describe, expect, it } from "vitest";
import {
  COST_PER_1M,
  estimateCost,
  estimateTokens,
  formatCost,
  formatCount,
  formatLatency,
  formatRate,
  formatWait,
  humanWait,
  parseWaitSeconds,
  percent,
  timeShort,
} from "@/lib/format";

describe("formatLatency", () => {
  it("uses ms precision under one second", () => {
    expect(formatLatency(5)).toBe("5ms");
    expect(formatLatency(999.4)).toBe("999ms");
    expect(formatLatency(0)).toBe("0ms");
  });

  it("switches to one-decimal seconds at 1000ms and above", () => {
    expect(formatLatency(1000)).toBe("1.0s");
    expect(formatLatency(1240)).toBe("1.2s");
    expect(formatLatency(27238.8)).toBe("27.2s");
  });

  it("renders an em dash for missing or non-finite values", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(undefined)).toBe("—");
    expect(formatLatency(Number.NaN)).toBe("—");
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatCount", () => {
  it("groups thousands with en-US separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("renders an em dash for missing or non-finite values", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });
});

describe("cost table", () => {
  it("looks up known models and computes USD from per-1M rates", () => {
    const gpt5 = COST_PER_1M["gpt-5"];
    expect(gpt5).toEqual({ in: 1.25, out: 10.0 });
    expect(estimateCost("gpt-5", { prompt: 1_000_000, completion: 1_000_000 })).toBeCloseTo(11.25);
  });

  it("returns null for unknown models instead of a fabricated default price", () => {
    expect(estimateCost("mystery-model", { prompt: 1_000_000, completion: 0 })).toBeNull();
    expect(estimateCost("mystery-model", { prompt: 1_000_000, completion: 1_000_000 })).toBeNull();
  });

  it("prices the :free tier as an honest zero", () => {
    expect(
      estimateCost("nvidia/nemotron-3-super-120b-a12b:free", {
        prompt: 1_000_000,
        completion: 1_000_000,
      }),
    ).toBe(0);
    expect(formatCost(estimateCost("test-lab/live-only:free", { prompt: 123, completion: 456 }))).toBe(
      "$0.00",
    );
  });

  it("returns 0 for missing token usage", () => {
    expect(estimateCost("gpt-5", null)).toBe(0);
    expect(estimateCost("gpt-5", undefined)).toBe(0);
    expect(estimateCost("gpt-5", {})).toBe(0);
  });

  it("formats cost honestly (sub-cent keeps 4 decimals)", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.5)).toBe("$0.50");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });
});

describe("estimateTokens", () => {
  it("approximates ~4 chars per token with a floor of 1", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("returns 0 for empty, whitespace-only or missing text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe("parseWaitSeconds (provider retry-wait parser)", () => {
  it("parses the compound h/m/s form", () => {
    expect(parseWaitSeconds("7h33m58.8s")).toBeCloseTo(27238.8);
    expect(parseWaitSeconds("1h2m3s")).toBe(3723);
  });

  it("parses retryDelay: N forms", () => {
    expect(parseWaitSeconds("retryDelay: 45s")).toBe(45);
    expect(parseWaitSeconds('"retryDelay": 60')).toBe(60);
  });

  it("parses 'retry in N s'", () => {
    expect(parseWaitSeconds("Please retry in 45.5s")).toBeCloseTo(45.5);
  });

  it("only parses m/s minute forms when the text mentions retry", () => {
    expect(parseWaitSeconds("retry 12m30s")).toBeCloseTo(750);
    expect(parseWaitSeconds("12m30s")).toBeNull();
  });

  it("returns null for text without a wait", () => {
    expect(parseWaitSeconds("quota exceeded")).toBeNull();
  });

  it("parses a bare '45s' as 45 seconds", () => {
    expect(parseWaitSeconds("45s")).toBe(45);
  });
});

describe("humanWait / formatWait", () => {
  it("renders compact waits", () => {
    expect(humanWait(45)).toBe("45s");
    expect(humanWait(480)).toBe("8m");
    expect(humanWait(27000)).toBe("7.5h");
    expect(humanWait(0)).toBeNull();
    expect(humanWait(null)).toBeNull();
  });

  it("chains parse + humanize", () => {
    expect(formatWait("7h33m58.8s")).toBe("7.6h");
    expect(formatWait("retryDelay: 45s")).toBe("45s");
    expect(formatWait("no wait here")).toBeNull();
    expect(formatWait(null)).toBeNull();
  });
});

describe("rate helpers", () => {
  it("percent is 0 when the whole is 0", () => {
    expect(percent(3, 4)).toBe(75);
    expect(percent(1, 0)).toBe(0);
  });

  it("formatRate keeps two decimals", () => {
    expect(formatRate(75)).toBe("75.00%");
    expect(formatRate(33.333)).toBe("33.33%");
  });
});

describe("timeShort", () => {
  it("renders local 24h time and an em dash for invalid input", () => {
    expect(timeShort("not-a-date")).toBe("—");
    expect(timeShort(new Date(2026, 0, 2, 14, 3, 22).toISOString())).toBe("14:03:22");
  });
});

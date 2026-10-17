/**
 * SessionPanel rendering: empty summary, derived hit-rate cell, chunks and
 * average TTFT cells.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionPanel } from "@/components/playground/SessionPanel";
import { EMPTY_STATS, type SessionStats } from "@/lib/types";

function cellValue(label: string): string {
  const value = screen.getByText(label).parentElement?.firstElementChild?.textContent ?? "";
  return value;
}

describe("SessionPanel", () => {
  it("shows 'No requests yet' for empty stats", () => {
    render(<SessionPanel stats={EMPTY_STATS} />);

    expect(screen.getByText("No requests yet")).toBeVisible();
  });

  it("derives the rate cell, chunks and average TTFT from stats", () => {
    const stats: SessionStats = {
      ...EMPTY_STATS,
      requests: 4,
      hits: 2,
      semanticHits: 1,
      misses: 2,
      bypassed: 0,
      promptTokens: 120,
      completionTokens: 80,
      chunks: 7,
      ttftMsTotal: 300,
      ttftCount: 3,
      latencyMsTotal: 500,
    };

    render(<SessionPanel stats={stats} />);

    expect(screen.getByText(/4 requests \(0 streamed\) · 50% HIT/)).toBeVisible();
    expect(cellValue("hit rate")).toBe("50%");
    expect(cellValue("stream chunks")).toBe("7");
    expect(cellValue("avg TTFT")).toBe("100ms");
    expect(cellValue("semantic hits")).toBe("1");
  });

  it("renders an em dash hit rate when no request reached a cache decision", () => {
    const noDecisions: SessionStats = { ...EMPTY_STATS, requests: 2, bypassed: 2 };

    render(<SessionPanel stats={noDecisions} />);

    expect(cellValue("hit rate")).toBe("—");
    expect(screen.getByText(/2 requests \(2 streamed\) · — HIT/)).toBeVisible();
  });
});

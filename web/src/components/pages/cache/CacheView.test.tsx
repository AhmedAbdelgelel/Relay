/**
 * Cache view: live /metrics fixture drives the six stat cards — exact hit
 * rate (3 hits / 1 miss → 75.00%) and the honest "--" mean similarity at 0.
 */

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheView } from "@/components/pages/cache/CacheView";
import { AppProvider } from "@/lib/store";
import { EMPTY_METRICS, type MetricsSnapshot } from "@/lib/types";
import { installFetch, jsonResponse } from "@/test/helpers";

const HEALTH = {
  ok: true,
  provider: "mock",
  cache: "memory",
  semantic: "memory",
  embedder: "hash",
};

const METRICS: MetricsSnapshot = { ...EMPTY_METRICS, exact_hits: 3, exact_misses: 1 };

/** The StatCard root containing the label (label div → sibling value div). */
function cardFor(label: string): HTMLElement {
  const card = screen.getByText(label).parentElement;
  if (!card) throw new Error(`StatCard not found for label: ${label}`);
  return card;
}

describe("CacheView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installFetch([
      ["/health", () => jsonResponse(HEALTH)],
      ["/metrics", () => jsonResponse(METRICS)],
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows the exact hit rate from the metrics fixture", async () => {
    render(
      <AppProvider>
        <CacheView />
      </AppProvider>,
    );

    expect(await screen.findByText("75.00%")).toBeVisible();
    expect(within(cardFor("Exact Hit Rate")).getByText("3 hit / 1 miss")).toBeVisible();
  });

  it("shows '--' for mean similarity while avg_semantic_score is 0", async () => {
    render(
      <AppProvider>
        <CacheView />
      </AppProvider>,
    );

    await screen.findByText("75.00%");
    expect(within(cardFor("Mean Similarity")).getByText("--")).toBeVisible();
  });
});

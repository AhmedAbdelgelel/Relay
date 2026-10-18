/**
 * Settings contracts: the Advanced toggle flips the persisted flag, the last
 * exchange has an honest empty state, and the cache configuration renders the
 * live /health config.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/pages/settings/SettingsView";
import { AppProvider } from "@/lib/store";
import type { HealthInfo } from "@/lib/types";
import { installFetch, jsonResponse } from "@/test/helpers";

const HEALTH: HealthInfo = {
  ok: true,
  provider: "mock",
  cache: "memory",
  semantic: "memory-vector",
  embedder: "memory",
  config: {
    cacheEnabled: true,
    cacheTtlSec: 300,
    semanticEnabled: true,
    semanticThreshold: 0.92,
    semanticTopK: 8,
    semanticTtlSec: 3600,
    upstreamTimeoutMs: 60000,
  },
};

function renderSettings() {
  render(
    <AppProvider>
      <SettingsView />
    </AppProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  installFetch([["/health", () => jsonResponse(HEALTH)]]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("SettingsView", () => {
  it("persists the Advanced toggle", () => {
    renderSettings();

    const toggle = screen.getByRole("switch", { name: "Show technical details" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("llm-gateway-advanced")).toBe("1");
  });

  it("shows the honest empty state before any exchange exists", () => {
    renderSettings();

    expect(
      screen.getByText("No exchange captured yet — send one from the Playground and it lands here."),
    ).toBeVisible();
  });

  it("renders the live cache configuration from /health", async () => {
    renderSettings();

    expect(await screen.findByText("0.92")).toBeVisible();
    expect(screen.getByText("Similarity threshold")).toBeVisible();
    expect(screen.getByText("3600s")).toBeVisible();
    // Exact cache + semantic cache are both reported enabled.
    expect(screen.getAllByText("enabled")).toHaveLength(2);
  });
});

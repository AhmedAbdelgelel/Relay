/**
 * Providers view: a mocked GET /providers payload renders the live line and
 * per-provider status pills.
 */

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersView } from "@/components/pages/providers/ProvidersView";
import { AppProvider } from "@/lib/store";
import type { ProviderStatus } from "@/lib/types";
import { installFetch, jsonResponse } from "@/test/helpers";

const PROVIDERS: ProviderStatus[] = [
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini"],
    configured: true,
    active: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1",
    models: ["claude-4"],
    configured: false,
    active: false,
  },
];

function providerCard(id: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`[data-provider="${id}"]`);
  if (!card) throw new Error(`provider card not found: ${id}`);
  return card;
}

describe("ProvidersView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installFetch([["/providers", () => jsonResponse(PROVIDERS)]]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders the live line and status pills from the /providers payload", async () => {
    render(
      <AppProvider>
        <ProvidersView />
      </AppProvider>,
    );

    expect(await screen.findByText("live · 1/2 configured · default openai")).toBeVisible();

    // Each card shows the status twice: the pill plus the "status" row.
    expect(within(providerCard("openai")).getAllByText("Connected")).toHaveLength(2);
    expect(within(providerCard("anthropic")).getAllByText("Not configured")).toHaveLength(2);
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
  });
});

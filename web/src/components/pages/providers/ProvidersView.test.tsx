/**
 * Providers view: a mocked GET /providers payload renders the live line and
 * per-provider status pills.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("ProvidersView add provider", () => {
  const REGISTER = {
    tenant_id: "t-9",
    provider: "openai",
    key: "lg_add_provider_test_key",
    key_prefix: "lg_add_",
  };

  it("registers a provider key and adopts the issued gateway key", async () => {
    const stub = installFetch([
      ["/providers", () => jsonResponse(PROVIDERS)],
      ["/v1/register", () => jsonResponse(REGISTER, 201)],
    ]);

    render(
      <AppProvider>
        <ProvidersView />
      </AppProvider>,
    );

    // Wait for the live list: the fixture has no openrouter entry, so the
    // default selection falls back to the first live option in the picker.
    expect(await screen.findByText("live · 1/2 configured · default openai")).toBeVisible();
    expect((document.getElementById("ap-provider") as HTMLSelectElement).value).toBe("openai");

    fireEvent.change(document.getElementById("ap-key") as HTMLInputElement, {
      target: { value: "sk-live-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register key" }));

    expect(await screen.findByText(REGISTER.key)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("llm-gateway-api-v1")).toContain(REGISTER.key);
    });

    // The visible selection is exactly what was registered.
    const call = stub.mock.calls.find((entry) => String(entry[0]).endsWith("/v1/register"));
    const body = JSON.parse(String(call?.[1]?.body)) as { provider: string };
    expect(body.provider).toBe("openai");
  });
});

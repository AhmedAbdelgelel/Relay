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
      ["/v1/connections", () => jsonResponse({ tenant_id: "t-9", connections: [] })],
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

describe("ProvidersView connect a provider", () => {
  it("connects a provider with your own key + URL, then shows the your-key row", async () => {
    window.localStorage.setItem(
      "llm-gateway-api-v1",
      JSON.stringify({ baseUrl: "", apiKey: "lg_web_test_key" }),
    );
    const stored: unknown[] = [];
    const stub = installFetch([
      ["/providers", () => jsonResponse(PROVIDERS)],
      [
        "/v1/connections",
        (init) => {
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as { provider: string; base_url?: string };
            const endpoint = body.base_url ?? "https://gateway-default.example/v1";
            const row = {
              provider: body.provider,
              base_url: body.base_url ?? null,
              endpoint,
              created_at: "2026-10-18T00:00:00.000Z",
            };
            stored.push(row);
            return jsonResponse({ ...row, connected: true }, 201);
          }
          return jsonResponse({ tenant_id: "t-9", connections: stored });
        },
      ],
    ]);

    render(
      <AppProvider>
        <ProvidersView />
      </AppProvider>,
    );

    expect(await screen.findByText("live · 1/2 configured · default openai")).toBeVisible();

    // The anthropic card offers "your key" connect; clicking preselects the form.
    fireEvent.click(within(providerCard("anthropic")).getByRole("button", { name: "Connect" }));
    expect((document.getElementById("cp-provider") as HTMLSelectElement).value).toBe("anthropic");

    fireEvent.change(document.getElementById("cp-key") as HTMLInputElement, {
      target: { value: "sk-tenant-anthropic" },
    });
    fireEvent.change(document.getElementById("cp-upstream") as HTMLInputElement, {
      target: { value: "https://own.anthropic.example/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Connected");

    const call = stub.mock.calls.find(
      (entry) => String(entry[0]).endsWith("/v1/connections") && entry[1]?.method === "POST",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      provider: "anthropic",
      provider_key: "sk-tenant-anthropic",
      base_url: "https://own.anthropic.example/v1",
    });

    // The refresh after connecting renders the stored credential on the card.
    await waitFor(() => {
      expect(
        within(providerCard("anthropic")).getByText("https://own.anthropic.example/v1"),
      ).toBeVisible();
    });
    expect(within(providerCard("anthropic")).getByText("connected")).toBeVisible();
  });

  it("keeps the connect form honest: an empty key shows a local error, no request", async () => {
    window.localStorage.setItem(
      "llm-gateway-api-v1",
      JSON.stringify({ baseUrl: "", apiKey: "lg_web_test_key" }),
    );
    const stub = installFetch([
      ["/providers", () => jsonResponse(PROVIDERS)],
      ["/v1/connections", () => jsonResponse({ tenant_id: "t-9", connections: [] })],
    ]);

    render(
      <AppProvider>
        <ProvidersView />
      </AppProvider>,
    );

    expect(await screen.findByText("live · 1/2 configured · default openai")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Paste the provider API key");
    expect(
      stub.mock.calls.some(
        (entry) => entry[1]?.method === "POST" && String(entry[0]).endsWith("/v1/connections"),
      ),
    ).toBe(false);
  });
});

/**
 * ModelPicker contracts: the $0 filter, picking a listed model, a custom id,
 * and Refresh pulling the LIVE OpenRouter free list plus the gateway's
 * configured models from /providers.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "@/components/playground/ModelPicker";
import { AppProvider } from "@/lib/store";
import type { ProviderStatus } from "@/lib/types";
import { installFetch, jsonResponse } from "@/test/helpers";

const OPENROUTER_MODELS = {
  data: [
    { id: "test-lab/live-only:free", pricing: { prompt: "0", completion: "0" } },
    { id: "test-lab/premium", pricing: { prompt: "0.000001", completion: "0.000002" } },
  ],
};

const GATEWAY_PROVIDERS: ProviderStatus[] = [
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-5-mini"],
    configured: true,
    active: true,
  },
];

function renderPicker(model = "gemini-3.6-flash") {
  const onSelect = vi.fn();
  render(
    <AppProvider>
      <ModelPicker model={model} onSelect={onSelect} />
    </AppProvider>,
  );
  return onSelect;
}

function openPicker() {
  fireEvent.click(document.getElementById("pg-model") as HTMLButtonElement);
  return screen.getByRole("listbox");
}

beforeEach(() => {
  window.localStorage.clear();
  installFetch([
    ["https://openrouter.ai/api/v1/models", () => jsonResponse(OPENROUTER_MODELS)],
    ["/providers", () => jsonResponse(GATEWAY_PROVIDERS)],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ModelPicker", () => {
  it("filters the bundled list down to the $0 tier", () => {
    renderPicker();
    const list = openPicker();

    expect(within(list).getByText("gemini-3.6-flash")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "$0 free" }));

    expect(within(list).queryByText("gemini-3.6-flash")).toBeNull();
    expect(within(list).getAllByText(/:free$/).length).toBeGreaterThan(0);
  });

  it("selects a listed model and closes the panel", () => {
    const onSelect = renderPicker();
    const list = openPicker();

    fireEvent.click(within(list).getByText("gemini-3.5-flash-lite"));

    expect(onSelect).toHaveBeenCalledWith("gemini-3.5-flash-lite");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("accepts a custom model id", () => {
    const onSelect = renderPicker();
    openPicker();

    fireEvent.change(screen.getByLabelText("Custom model id"), {
      target: { value: "my-org/custom-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));

    expect(onSelect).toHaveBeenCalledWith("my-org/custom-model");
  });

  it("refreshes with the live $0 list and the gateway's configured models", async () => {
    renderPicker();
    const list = openPicker();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(within(list).getByRole("option", { name: /test-lab\/live-only:free/ })).toBeVisible();
    });
    // Only the $0 tier is pulled from OpenRouter (the paid one is filtered out
    // by design)…
    expect(within(list).queryByRole("option", { name: /test-lab\/premium/ })).toBeNull();
    // …and /providers models merge into their prefix's group (gpt- → openai).
    expect(within(list).getByRole("option", { name: /gpt-5-mini/ })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByText(/Updated /)).toBeVisible();
    });
  });
});

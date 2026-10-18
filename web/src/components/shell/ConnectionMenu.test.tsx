/**
 * ConnectionMenu contracts: the register-in-place disclosure issues a key
 * through POST /v1/register and "Use this key" must save THAT key — the
 * originally-shipping bug was applying the stale draft when the two state
 * updates raced (apply() read the old apiKey closure).
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectionMenu } from "@/components/shell/ConnectionMenu";
import { AppProvider } from "@/lib/store";
import { installFetch, jsonResponse } from "@/test/helpers";
import type { FetchMock } from "@/test/helpers";

let fetchStub: FetchMock;

beforeEach(() => {
  window.localStorage.clear();
  fetchStub = installFetch([["/v1/register", () => jsonResponse(REGISTER_BODY, 201)]]);
});

const REGISTER_BODY = {
  tenant_id: "t-1",
  provider: "mock",
  key: "lg_issued_by_register_test",
  key_prefix: "lg_issu",
};

function renderMenu() {
  render(
    <AppProvider>
      <ConnectionMenu />
    </AppProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /dev-workspace/ }));
  fireEvent.click(screen.getByText("Register a gateway key"));
}

describe("ConnectionMenu register-in-place", () => {
  it("registers and 'Use this key' saves the issued key (not the stale draft)", async () => {
    renderMenu();

    fireEvent.change(document.getElementById("reg-name") as HTMLInputElement, {
      target: { value: "contract-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    // 201 shows the key once…
    expect(await screen.findByText(REGISTER_BODY.key)).toBeVisible();

    // …and "Use this key" applies exactly that key.
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));

    await waitFor(() => {
      const saved = window.localStorage.getItem("llm-gateway-api-v1");
      expect(saved).toContain(REGISTER_BODY.key);
    });

    // Register went through the open route: no Authorization header.
    const registerCall = fetchStub.mock.calls.find((call) => String(call[0]).endsWith("/v1/register"));
    const headers = new Headers(registerCall?.[1]?.headers as HeadersInit);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("a failed registration surfaces the gateway message inline", async () => {
    fetchStub.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ error: { code: "validation_error", message: "provider nope" } }, 400),
      ),
    );

    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    expect(await screen.findByText("provider nope")).toBeVisible();
    // The failed attempt leaves the register affordance in place.
    expect(screen.getByRole("button", { name: "Register" })).toBeVisible();
  });
});

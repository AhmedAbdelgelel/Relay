/**
 * Request Inspector empty state: the exact legacy copy shown before any live
 * exchange was captured.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestInspector } from "@/components/pages/requests/RequestInspector";
import { AppProvider } from "@/lib/store";
import { installFetch } from "@/test/helpers";

const EMPTY_COPY =
  "No live request yet — send one from the Playground to inspect the real pipeline.";

describe("RequestInspector", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installFetch([]); // /health + /metrics polls never settle
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows the exact empty-state copy when there is no live request", () => {
    render(
      <AppProvider>
        <RequestInspector />
      </AppProvider>,
    );

    expect(screen.getByRole("heading", { name: "Request Inspector" })).toBeVisible();
    expect(screen.getByText(EMPTY_COPY)).toBeVisible();
  });
});

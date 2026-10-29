/**
 * Metrics line + evidence card rendering contracts:
 * ms-precision latency, "cache HIT", the exact HIT/BYPASS hint copy, the
 * SEMANTIC_HIT similarity readout and the cache-key display.
 */

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricsCard, MetricsLine, metricsLineText } from "@/components/playground/Metrics";
import type { Evidence, MessageMeta } from "@/lib/types";

const HIT_HINT =
  "Exact match found for this canonical key — served from cache, the provider was NOT called.";
const BYPASS_HINT = "stream:true bypasses the exact cache (an SSE stream cannot replay a stored blob).";

function meta(overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    verdict: "HIT",
    provider: "mock",
    model: "gpt-5",
    latencyMs: 250,
    promptTokens: 10,
    completionTokens: 20,
    requestId: "req-1",
    at: "2026-01-02T14:03:22.000Z",
    ...overrides,
  };
}

function Harness({ message, evidence }: { message: MessageMeta; evidence?: Evidence }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MetricsLine
        meta={message}
        open={open}
        cardId="metrics-card"
        onToggle={() => setOpen((value) => !value)}
      />
      <MetricsCard meta={message} evidence={evidence} id="metrics-card" open={open} />
    </>
  );
}

function toggle(): HTMLElement {
  const button = screen.getByRole("button", { name: /cache (HIT|SEMANTIC_HIT|MISS|BYPASS)/ });
  fireEvent.click(button);
  return button;
}

describe("metrics line", () => {
  it("shows ms-precision latency and cache HIT", () => {
    render(<Harness message={meta()} />);

    const line = screen.getByRole("button", { name: /cache HIT/ });
    expect(line).toHaveTextContent("250ms");
    expect(line).toHaveTextContent("cache HIT");
    expect(line).toHaveTextContent("10 in · 20 out");
    expect(metricsLineText(meta())).toBe("250ms · 10 in · 20 out · cache HIT · gpt-5");
  });
});

describe("evidence card", () => {
  it("stays hidden until toggled, then reveals the exact HIT hint", () => {
    render(<Harness message={meta()} />);

    expect(screen.getByText(HIT_HINT)).not.toBeVisible();

    const button = toggle();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(HIT_HINT)).toBeVisible();
  });

  it("SEMANTIC_HIT shows the measured similarity in the hint and routing row", () => {
    const message = meta({ verdict: "SEMANTIC_HIT" });
    const evidence: Evidence = {
      requestId: "req-1",
      lane: "registered",
      provider: "mock",
      cache: "SEMANTIC_HIT",
      cacheHash: null,
      latencyMs: 12,
      semanticSimilarity: 0.9375,
    };

    render(<Harness message={message} evidence={evidence} />);
    expect(screen.getByRole("button", { name: /cache SEMANTIC_HIT/ })).toHaveTextContent(
      "cache SEMANTIC_HIT",
    );

    toggle();
    expect(screen.getByText(/with similarity 0\.9375/)).toBeVisible();
    expect(screen.getByText(/^similarity 0\.9375$/)).toBeVisible();
  });

  it("BYPASS hint explains the stream:true cache bypass", () => {
    render(<Harness message={meta({ verdict: "BYPASS", chunks: 4, ttftMs: 90 })} />);

    toggle();
    expect(screen.getByText(BYPASS_HINT)).toBeVisible();
    expect(screen.getByText(/stream:true bypasses the exact cache/)).toBeVisible();
  });

  it("renders llm:exact:v2:<tenant>:<provider>:<hash> when the gateway sent a hash", () => {
    const message = meta({ cacheHash: "deadbeef" });
    const evidence: Evidence = {
      requestId: "req-1",
      lane: "registered",
      provider: "mock",
      cache: "HIT",
      cacheHash: "deadbeef",
      latencyMs: 12,
    };

    render(<Harness message={message} evidence={evidence} />);
    toggle();

    expect(screen.getByText("llm:exact:v2:<tenant>:mock:deadbeef")).toBeVisible();
  });
});

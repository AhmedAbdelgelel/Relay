/**
 * Thread rendering contracts: empty-state greeting + 3 suggestion chips,
 * user/assistant rows, the amber notice style, and the suggestion callback.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Thread, type LiveState, type PendingState } from "@/components/playground/Thread";
import { cacheHint, SUGGESTIONS } from "@/components/playground/catalog";
import type { ChatRecord, MessageMeta } from "@/lib/types";

function assistantMeta(): MessageMeta {
  return {
    verdict: "HIT",
    provider: "mock",
    model: "gpt-5",
    latencyMs: 42,
    requestId: "req-1",
    at: "2026-01-02T14:03:22.000Z",
  };
}

const FILLED_CHAT: ChatRecord = {
  id: "chat-1",
  title: "Hello there",
  updatedAt: "2026-01-02T14:03:22.000Z",
  messages: [
    { id: "m1", role: "user", kind: "normal", text: "Hello there" },
    {
      id: "m2",
      role: "assistant",
      kind: "normal",
      text: "General Kenobi!",
      meta: assistantMeta(),
    },
  ],
};

function renderThread(chat: ChatRecord | null, onPick = vi.fn(), detailed = true) {
  render(
    <Thread
      chat={chat}
      fallbackLabel="Gemini"
      live={null}
      pending={null}
      regenerateId={null}
      retryId={null}
      detailed={detailed}
      onRegenerate={vi.fn()}
      onRetry={vi.fn()}
      onPick={onPick}
    />,
  );
  return onPick;
}

describe("Thread empty state", () => {
  it("renders the greeting and the 3 suggestion chips", () => {
    renderThread(null);

    expect(screen.getByText("Connected through your gateway to Gemini. Ask anything.")).toBeVisible();
    expect(SUGGESTIONS).toHaveLength(3);
    for (const suggestion of SUGGESTIONS) {
      expect(screen.getByRole("button", { name: suggestion })).toBeVisible();
    }
  });

  it("fills the composer through onPick when a chip is clicked", () => {
    const onPick = renderThread(null);
    const chip = SUGGESTIONS[2];

    fireEvent.click(screen.getByRole("button", { name: chip }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(chip);
  });
});

describe("Thread message rows", () => {
  it("renders user and assistant rows", () => {
    renderThread(FILLED_CHAT);

    expect(screen.getByText("Hello there")).toBeVisible();
    expect(screen.getByText("General Kenobi!")).toBeVisible();
    // The who-line appears once visibly; the hidden metrics card repeats the
    // raw provider · model pair in its Provider row.
    const who = screen.getAllByText("Mock · gpt-5");
    expect(who.length).toBeGreaterThan(0);
    expect(who[0]).toBeVisible();
  });

  it("renders notice rows with the amber notice style", () => {
    const noticeChat: ChatRecord = {
      ...FILLED_CHAT,
      messages: [
        { id: "n1", role: "assistant", kind: "notice", text: "Empty response from the provider." },
      ],
    };

    renderThread(noticeChat);

    const noticeText = screen.getByText("Empty response from the provider.");
    expect(noticeText).toHaveClass("text-warn");
    expect(noticeText.parentElement).toHaveClass("bg-warn-soft");
  });

  it("renders lane/key evidence persisted on the message (survives a reload)", () => {
    const persisted: ChatRecord = {
      ...FILLED_CHAT,
      messages: [
        FILLED_CHAT.messages[0],
        {
          ...FILLED_CHAT.messages[1],
          evidence: {
            requestId: "req-1",
            lane: "registered",
            keyId: "key-6027c011",
            provider: "mock",
            cache: "HIT",
            cacheHash: "f25cf6bc",
            latencyMs: 0,
            coalesced: false,
            semanticSimilarity: null,
            fallback: null,
          },
        },
      ],
    };

    renderThread(persisted);
    fireEvent.click(screen.getByRole("button", { name: /cache HIT/ }));

    expect(screen.getByText("registered")).toBeVisible();
    expect(screen.getByText(/key key-6027c011 · coalesced false/)).toBeVisible();
  });

  it("shows the compact cache verdict but not the metrics card when Advanced is off", () => {
    renderThread(FILLED_CHAT, vi.fn(), false);

    // Simple mode keeps the one caching surface a caching-focused user needs…
    expect(screen.getByText("HIT")).toBeVisible();
    expect(screen.getByText(cacheHint("HIT"))).toBeVisible();
    // …while the metrics line, evidence card and expanded card stay behind Advanced.
    expect(screen.queryByRole("button", { name: /cache HIT/ })).toBeNull();
    expect(screen.getByText("General Kenobi!")).toBeVisible();
  });
});

function renderThreadState({
  detailed = false,
  live = null,
  pending = null,
}: {
  detailed?: boolean;
  live?: LiveState | null;
  pending?: PendingState | null;
}) {
  render(
    <Thread
      chat={FILLED_CHAT}
      fallbackLabel="Gemini"
      live={live}
      pending={pending}
      regenerateId={null}
      retryId={null}
      detailed={detailed}
      onRegenerate={vi.fn()}
      onRetry={vi.fn()}
      onPick={vi.fn()}
    />,
  );
}

describe("Thinking / Generating animation states", () => {
  it("shows the animated Thinking row, with three bouncing dots, while a reply is pending", () => {
    renderThreadState({ pending: { who: "OpenRouter", model: "cohere/north-mini-code:free" } });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Thinking");
    expect(status.querySelectorAll(".relay-dot")).toHaveLength(3);
  });

  it("switches to an animated Generating row while streaming (simple mode keeps only the label)", () => {
    renderThreadState({
      live: { messageId: "m2", who: "OpenRouter", model: "cohere/north-mini-code:free", chunks: 3, elapsedMs: 1200 },
      detailed: false,
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Generating");
    expect(status.querySelectorAll(".relay-dot")).toHaveLength(3);
    expect(status).not.toHaveTextContent("chunks");
  });

  it("appends chunk / elapsed / ≈token stats to the Generating row in Advanced mode", () => {
    renderThreadState({
      live: { messageId: "m2", who: "OpenRouter", model: "cohere/north-mini-code:free", chunks: 3, elapsedMs: 1200 },
      detailed: true,
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("3 chunks");
    expect(status).toHaveTextContent("1.2s");
    expect(status).toHaveTextContent("≈");
  });
});

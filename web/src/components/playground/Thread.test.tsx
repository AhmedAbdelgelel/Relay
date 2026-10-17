/**
 * Thread rendering contracts: empty-state greeting + 3 suggestion chips,
 * user/assistant rows, the amber notice style, and the suggestion callback.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Thread } from "@/components/playground/Thread";
import { SUGGESTIONS } from "@/components/playground/catalog";
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

function renderThread(chat: ChatRecord | null, onPick = vi.fn()) {
  render(
    <Thread
      chat={chat}
      fallbackLabel="Gemini"
      live={null}
      pending={null}
      evidenceById={{}}
      regenerateId={null}
      retryId={null}
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
    // provider · model pair in its Provider row.
    const who = screen.getAllByText("mock · gpt-5");
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
});

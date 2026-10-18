"use client";

/**
 * Left request panel: the simple composer — model, system + user message,
 * streaming toggle, Send/Stop · Clear.
 *
 * Sampling leaves no UI: temperature/max_tokens are normalized by the gateway
 * (temperature ?? 1.0, no cap) and the cache identity follows that same
 * normalization, so nothing can drift between the wire and the cache key.
 * The gateway connection is edited in Settings (and the sidebar menu); the
 * technical surfaces (metrics, evidence, trace, session counters) only appear
 * when Settings → Advanced is on.
 */

import { useEffect, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { Button, Card, CardTitle, Kbd, Switch } from "@/components/ui";
import { estimateTokens } from "@/lib/format";
import { cn } from "@/lib/cn";
import { type PlaygroundDraft } from "./draft";
import { ModelPicker } from "./ModelPicker";
import { IconArrowUp, IconStopSquare } from "./icons";

const textareaClasses =
  "w-full rounded-control border border-line bg-canvas px-2.5 py-2 text-[13px] leading-5 text-ink placeholder:text-placeholder";

/** Composer auto-grow cap (legacy autoGrow(): 180px). */
const COMPOSER_MAX_HEIGHT = 180;

export interface RequestPanelProps {
  form: PlaygroundDraft;
  onPatch: (patch: Partial<PlaygroundDraft>) => void;
  running: boolean;
  onSendOrStop: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

export function RequestPanel({
  form,
  onPatch,
  running,
  onSendOrStop,
  composerRef,
}: RequestPanelProps) {
  const [streamHintOpen, setStreamHintOpen] = useState(false);

  // Auto-grow is imperative sizing (not design styling): measure and cap.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [form.user, composerRef]);

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An Enter that confirms an IME composition (CJK input) must never send.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSendOrStop();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      onSendOrStop();
    }
  };

  const clear = () => {
    onPatch({ user: "", system: "" });
    composerRef.current?.focus();
  };

  return (
    <Card className="lg:sticky lg:top-16">
      <CardTitle>Request</CardTitle>
      <div className="space-y-3">
        <div>
          <label htmlFor="pg-model" className="text-[11px] text-ink-3">
            Model
          </label>
          <ModelPicker model={form.model} onSelect={(model) => onPatch({ model })} />
        </div>

        <div>
          <label htmlFor="pg-system" className="text-[11px] text-ink-3">
            System
          </label>
          <textarea
            id="pg-system"
            rows={2}
            value={form.system}
            onChange={(event) => onPatch({ system: event.target.value })}
            placeholder="You are a helpful assistant."
            className={cn(textareaClasses, "resize-none")}
          />
        </div>

        <div>
          <label htmlFor="pg-composer" className="text-[11px] text-ink-3">
            User message
          </label>
          <textarea
            id="pg-composer"
            ref={composerRef}
            rows={4}
            value={form.user}
            onChange={(event) => onPatch({ user: event.target.value })}
            onKeyDown={onComposerKeyDown}
            placeholder="Send a prompt through the gateway…"
            className={cn(textareaClasses, "overflow-y-auto")}
          />
          <div className="mt-1 text-right text-[11px] text-ink-3 tabular-nums">
            ≈ {estimateTokens(form.user).toLocaleString("en-US")} tokens
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            type="button"
            id="pg-stream-label"
            onClick={() => setStreamHintOpen((prev) => !prev)}
            aria-expanded={streamHintOpen}
            title="Streaming bypasses the exact cache"
            className="text-[11px] text-ink-3 underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-ink-2"
          >
            Streaming
          </button>
          <Switch
            checked={form.stream}
            onToggle={() => onPatch({ stream: !form.stream })}
            labelledBy="pg-stream-label"
          />
        </div>
        {streamHintOpen ? (
          <p className="text-[11px] leading-4 text-ink-3">
            Streamed replies bypass the exact cache — an SSE stream cannot replay a stored blob.
            Toggle it off to exercise HIT / MISS behavior.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd> send
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Shift</Kbd>
            <span aria-hidden="true">+</span>
            <Kbd>Enter</Kbd> newline
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd> stop
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={onSendOrStop}
            aria-label={running ? "Stop request" : "Send request"}
            className="min-w-0 flex-1"
          >
            {running ? <IconStopSquare size={14} /> : <IconArrowUp size={14} />}
            {running ? "Stop" : "Send Request"}
          </Button>
          <Button onClick={clear}>Clear</Button>
        </div>
      </div>
    </Card>
  );
}

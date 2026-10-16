"use client";

/**
 * Left request panel: connection, provider/model catalog, sampling controls,
 * system + user message, keyboard hint bar and the Send/Stop · Clear ·
 * Save Test actions (inventory §2.2, redesigned per agent/ui-nextjs.md).
 */

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { Button, Card, CardTitle, Kbd } from "@/components/ui";
import { buildPayload } from "@/lib/canonical";
import { estimateTokens } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PROVIDER_ORDER, PROVIDERS } from "./catalog";
import { type PlaygroundDraft } from "./draft";
import { copyText } from "./clipboard";
import { ConnectionFields } from "./ConnectionFields";
import { IconArrowUp, IconStopSquare } from "./icons";

const inputClasses =
  "h-8 w-full rounded-control border border-line bg-canvas px-2 text-[12px] text-ink placeholder:text-placeholder";
const textareaClasses =
  "w-full rounded-control border border-line bg-canvas px-2.5 py-2 text-[13px] leading-5 text-ink placeholder:text-placeholder";

/** Composer auto-grow cap (legacy autoGrow(): 180px). */
const COMPOSER_MAX_HEIGHT = 180;

export interface RequestPanelProps {
  form: PlaygroundDraft;
  onPatch: (patch: Partial<PlaygroundDraft>) => void;
  running: boolean;
  onSendOrStop: () => void;
  connectionKey: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

export function RequestPanel({
  form,
  onPatch,
  running,
  onSendOrStop,
  connectionKey,
  composerRef,
}: RequestPanelProps) {
  const saveTimer = useRef<number | null>(null);
  const [tokensText, setTokensText] = useState(String(form.maxTokens));
  const [saved, setSaved] = useState(false);

  // Auto-grow is imperative sizing (not design styling): measure and cap.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [form.user, composerRef]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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

  const saveTest = () => {
    const payload = buildPayload({
      model: form.model,
      system: form.system,
      user: form.user,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      stream: form.stream,
    });
    void copyText(JSON.stringify(payload, null, 2)).then((ok) => {
      if (!ok) return;
      setSaved(true);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => setSaved(false), 1200);
    });
  };

  const onTokensChange = (raw: string) => {
    setTokensText(raw);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) onPatch({ maxTokens: parsed });
  };

  const onTemperatureChange = (raw: string) => {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) onPatch({ temperature: parsed });
  };

  const providerModels = (PROVIDERS[form.provider] ?? PROVIDERS.google).models;

  return (
    <Card className="lg:sticky lg:top-16 lg:max-h-[calc(100dvh-5rem)] lg:overflow-y-auto">
      <CardTitle>Request</CardTitle>
      <div className="space-y-3">
        <ConnectionFields key={connectionKey} />

        <div>
          <label htmlFor="pg-provider" className="text-[11px] text-ink-3">
            Provider
          </label>
          <select
            id="pg-provider"
            value={form.provider}
            onChange={(event) => {
              const provider = event.target.value;
              const models = (PROVIDERS[provider] ?? PROVIDERS.google).models;
              onPatch({
                provider,
                model: models.includes(form.model) ? form.model : models[0],
              });
            }}
            className={inputClasses}
          >
            {PROVIDER_ORDER.map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id].label}
              </option>
            ))}
          </select>
        </div>

        <p className="text-[11px] leading-4 text-ink-3">
          Model prefix routes automatically (gpt-* → openai, claude-* → anthropic, gemini-* →
          google). API keys come from server env, never the browser.
        </p>

        <div>
          <label htmlFor="pg-model" className="text-[11px] text-ink-3">
            Model
          </label>
          <select
            id="pg-model"
            value={form.model}
            onChange={(event) => onPatch({ model: event.target.value })}
            className={inputClasses}
          >
            {providerModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="pg-temperature" className="text-[11px] text-ink-3">
              Temperature
            </label>
            <span aria-hidden="true" className="text-[11px] text-ink-2 tabular-nums">
              {form.temperature.toFixed(1)}
            </span>
          </div>
          <input
            id="pg-temperature"
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={form.temperature}
            aria-valuetext={form.temperature.toFixed(1)}
            onChange={(event) => onTemperatureChange(event.target.value)}
            className="mt-1 w-full accent-accent"
          />
        </div>

        <div>
          <label htmlFor="pg-max-tokens" className="text-[11px] text-ink-3">
            Max tokens
          </label>
          <input
            id="pg-max-tokens"
            type="number"
            min={1}
            max={8192}
            value={tokensText}
            onChange={(event) => onTokensChange(event.target.value)}
            onBlur={() => setTokensText(String(form.maxTokens))}
            className={inputClasses}
          />
        </div>

        <div className="flex items-center justify-between">
          <span id="pg-stream-label" className="text-[11px] text-ink-3">
            Streaming
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={form.stream}
            aria-labelledby="pg-stream-label"
            onClick={() => onPatch({ stream: !form.stream })}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-line transition-colors duration-150",
              form.stream ? "bg-btn" : "bg-sunken",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block size-3.5 rounded-full transition-transform duration-150",
                form.stream ? "translate-x-[18px] bg-btn-text" : "translate-x-[2px] bg-ink-3",
              )}
            />
          </button>
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
          <span>stream requests bypass the cache</span>
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
          <Button
            onClick={saveTest}
            title="Copy the payload JSON for this form"
            aria-live="polite"
          >
            {saved ? "Copied" : "Save Test"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

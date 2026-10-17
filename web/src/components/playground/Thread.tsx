"use client";

/**
 * Conversation thread: empty-state greeting + suggestion chips, user
 * bubbles, full-width assistant rows with the collapsible metrics, amber
 * empty-response notices and error cards (quota 429 with Retry).
 *
 * The live/draft rows are drawn from page state; everything committed lives in
 * the store so it survives chat switches and reloads.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMessage, ChatRecord, Evidence } from "@/lib/types";
import { Button } from "@/components/ui";
import { estimateTokens, timeShort } from "@/lib/format";
import { providerDisplayLabel, SUGGESTIONS } from "./catalog";
import { copyText } from "./clipboard";
import { MetricsCard, MetricsLine } from "./Metrics";

export interface LiveState {
  messageId: string;
  who: string;
  model: string;
  chunks: number;
  elapsedMs: number;
}

export interface PendingState {
  who: string;
  model: string;
}

interface ThreadProps {
  chat: ChatRecord | null;
  fallbackLabel: string;
  live: LiveState | null;
  pending: PendingState | null;
  regenerateId: string | null;
  retryId: string | null;
  onRegenerate: () => void;
  onRetry: () => void;
  onPick: (text: string) => void;
}

/** "{Provider} · {model}" — x-provider evidence wins, selection label is the fallback. */
function whoLine(provider: string | null, model: string | null, fallback: string): string {
  const name = provider ? providerDisplayLabel(provider) : fallback;
  return model ? `${name} · ${model}` : name;
}

function WhoLine({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-ink-3">{children}</div>;
}

function CopyToolButton({ text }: { text: string }) {
  const timer = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded-[6px] px-1.5 py-0.5 text-[11px] text-ink-3 transition-colors duration-150 hover:bg-wash hover:text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function RegenerateToolButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[6px] px-1.5 py-0.5 text-[11px] text-ink-3 transition-colors duration-150 hover:bg-wash hover:text-ink"
    >
      Regenerate
    </button>
  );
}

function UserRow({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-[14px] bg-sunken px-3.5 py-2 text-[13px] leading-5 break-words whitespace-pre-wrap text-ink">
        {text}
      </div>
    </div>
  );
}

function AssistantRow({
  message,
  fallbackLabel,
  evidence,
  isLive,
  live,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMessage;
  fallbackLabel: string;
  evidence: Evidence | undefined;
  isLive: boolean;
  live: LiveState | null;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = message.meta;
  const who = meta
    ? whoLine(meta.provider, meta.model, fallbackLabel)
    : live
      ? whoLine(null, live.model, live.who)
      : fallbackLabel;
  const cardId = `metrics-${message.id}`;

  return (
    <div className="flex flex-col">
      <WhoLine>{who}</WhoLine>
      <div className="mt-0.5 text-[13px] leading-6 break-words whitespace-pre-wrap text-ink">
        {message.text}
        {isLive ? (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-ink-2"
          />
        ) : null}
      </div>
      {isLive && live ? (
        <div className="mt-1 text-[11px] text-ink-3 tabular-nums">
          streaming · {live.chunks} chunks · {(live.elapsedMs / 1000).toFixed(1)}s · ≈{" "}
          {estimateTokens(message.text).toLocaleString("en-US")} tok
        </div>
      ) : null}
      {!isLive && meta ? (
        <>
          <MetricsLine
            meta={meta}
            open={open}
            cardId={cardId}
            onToggle={() => setOpen((prev) => !prev)}
          />
          <MetricsCard meta={meta} evidence={evidence} id={cardId} open={open} />
        </>
      ) : null}
      {!isLive ? (
        <div className="mt-1 flex items-center gap-1">
          <CopyToolButton text={message.text} />
          {canRegenerate ? <RegenerateToolButton onClick={onRegenerate} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function NoticeRow({
  message,
  fallbackLabel,
  evidence,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMessage;
  fallbackLabel: string;
  evidence: Evidence | undefined;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = message.meta;
  const cardId = `metrics-${message.id}`;

  return (
    <div className="rounded-control border border-line bg-warn-soft px-3.5 py-2.5">
      <WhoLine>
        {meta ? whoLine(meta.provider, meta.model, fallbackLabel) : fallbackLabel}
      </WhoLine>
      <div className="mt-0.5 text-[13px] leading-5 text-warn">{message.text}</div>
      {meta ? (
        <>
          <MetricsLine
            meta={meta}
            open={open}
            cardId={cardId}
            onToggle={() => setOpen((prev) => !prev)}
          />
          <MetricsCard meta={meta} evidence={evidence} id={cardId} open={open} />
        </>
      ) : null}
      <div className="mt-1 flex items-center gap-1">
        <CopyToolButton text={message.text} />
        {canRegenerate ? <RegenerateToolButton onClick={onRegenerate} /> : null}
      </div>
    </div>
  );
}

function ErrorRow({
  message,
  fallbackLabel,
  canRetry,
  onRetry,
}: {
  message: ChatMessage;
  fallbackLabel: string;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const [title, ...rest] = message.text.split("\n");
  const body = rest.join("\n").trim();
  const meta = message.meta;

  return (
    <div className="rounded-control border border-line bg-err-soft px-3.5 py-2.5">
      <WhoLine>
        {meta?.provider ? providerDisplayLabel(meta.provider) : fallbackLabel}
      </WhoLine>
      <div className="mt-0.5 text-[13px] leading-5 font-medium text-err">{title}</div>
      {body ? (
        <div className="mt-0.5 text-[12px] leading-5 break-words whitespace-pre-wrap text-ink-2">
          {body}
        </div>
      ) : null}
      <div className="mt-1.5 text-[11px] text-ink-3 tabular-nums">
        request {meta?.requestId ?? "—"} · {meta ? timeShort(meta.at) : "—"}
      </div>
      {canRetry ? (
        <div className="mt-2">
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PendingRow({ who, model }: PendingState) {
  return (
    <div className="flex flex-col">
      <WhoLine>{whoLine(null, model, who)}</WhoLine>
      <div className="mt-1 flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3" />
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:120ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:240ms]" />
      </div>
    </div>
  );
}

function EmptyThread({
  fallbackLabel,
  onPick,
}: {
  fallbackLabel: string;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="text-[13px] text-ink-2">
        Connected through your gateway to {fallbackLabel}. Ask anything.
      </p>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-pill border border-line bg-canvas px-3 py-1.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Thread({
  chat,
  fallbackLabel,
  live,
  pending,
  regenerateId,
  retryId,
  onRegenerate,
  onRetry,
  onPick,
}: ThreadProps) {
  const messages = chat?.messages ?? [];
  const empty = messages.length === 0 && !pending && !live;

  if (empty) {
    return <EmptyThread fallbackLabel={fallbackLabel} onPick={onPick} />;
  }

  return (
    <>
      {messages.map((message) => {
        if (message.role === "user") {
          return <UserRow key={message.id} text={message.text} />;
        }
        if (message.kind === "error") {
          return (
            <ErrorRow
              key={message.id}
              message={message}
              fallbackLabel={fallbackLabel}
              canRetry={retryId === message.id}
              onRetry={onRetry}
            />
          );
        }
        if (message.kind === "notice") {
          return (
            <NoticeRow
              key={message.id}
              message={message}
              fallbackLabel={fallbackLabel}
              evidence={message.evidence}
              canRegenerate={regenerateId === message.id}
              onRegenerate={onRegenerate}
            />
          );
        }
        return (
          <AssistantRow
            key={message.id}
            message={message}
            fallbackLabel={fallbackLabel}
            evidence={message.evidence}
            isLive={live !== null && live.messageId === message.id}
            live={live}
            canRegenerate={regenerateId === message.id}
            onRegenerate={onRegenerate}
          />
        );
      })}
      {pending ? (
        <PendingRow who={pending.who} model={pending.model} />
      ) : null}
    </>
  );
}

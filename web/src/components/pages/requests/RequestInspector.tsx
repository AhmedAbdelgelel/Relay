"use client";

/**
 * Requests — "Request Inspector" (inventory §2.3).
 *
 * Reads the last exchange the Playground captured (in-memory only) and shows
 * every stage as real data: what the client sent, the canonical form, the
 * evidence the provider lane returned, and what the client finally received
 * (rough edge #9 — no placeholder panels).
 */

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Card, CardTitle, EmptyState, verdictTone } from "@/components/ui";
import { IconRequests } from "@/components/ui/icons";
import { JsonBlock } from "@/components/pages/shared/JsonBlock";
import { PageShell } from "@/components/pages/shared/PageShell";
import { useAppStore } from "@/lib/store";
import type { LastIO } from "@/lib/types";

const FLOW = [
  "Client",
  "Gateway",
  "Canonicalization",
  "Routing",
  "Adapter",
  "Provider",
  "Adapter",
  "Canonical Response",
  "Client",
] as const;

/** Legacy copy, verbatim (public/js/app.js viewRequests). */
const EMPTY_COPY =
  "No live request yet — send one from the Playground to inspect the real pipeline.";

/** Pretty-print JSON text when parseable (canonical arrives single-line). */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function ageLabel(capturedAt: number, now: number): string {
  const delta = Math.max(0, now - capturedAt);
  if (delta < 1000) return "captured just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `captured ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `captured ${minutes}m ago`;
  return `captured ${Math.floor(minutes / 60)}h ago`;
}

interface Clock {
  anchor: LastIO;
  now: number;
  capturedAt: number;
}

/**
 * Live "now" for the age label. Started from an effect (never during render,
 * docs/08) and re-anchored whenever a new lastIO arrives; `capturedAt` is the
 * first tick after that change unless a chat message timestamp matches.
 */
function useClock(lastIO: LastIO | null): Clock | null {
  const [clock, setClock] = useState<Clock | null>(null);

  useEffect(() => {
    if (!lastIO) return;
    const tick = () => {
      const now = Date.now();
      setClock((prev) =>
        prev && prev.anchor === lastIO ? { ...prev, now } : { anchor: lastIO, now, capturedAt: now },
      );
    };
    const first = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [lastIO]);

  return clock;
}

/**
 * Timestamp + stream chunk count of the assistant message this lastIO belongs
 * to. Pure derivation from the store's chats (no time reads during render);
 * the React Compiler memoizes it.
 */
function useMatchedMeta(lastIO: LastIO | null): { at: number | null; chunks: number | null } {
  const { chats } = useAppStore();
  const requestId = lastIO?.evidence.requestId ?? null;

  if (!requestId) return { at: null, chunks: null };
  for (const chat of chats) {
    for (const message of chat.messages) {
      const meta = message.meta;
      if (message.role !== "assistant" || !meta || meta.requestId !== requestId) continue;
      const at = Date.parse(meta.at);
      return { at: Number.isFinite(at) ? at : null, chunks: meta.chunks ?? null };
    }
  }
  return { at: null, chunks: null };
}

function InspectorPanel({
  title,
  badge,
  caption,
  children,
}: {
  title: string;
  badge?: ReactNode;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex min-w-0 flex-col">
      <CardTitle actions={badge}>{title}</CardTitle>
      <div className="min-w-0 flex-1">{children}</div>
      {caption ? <p className="mt-2 text-[11px] leading-4 text-ink-3">{caption}</p> : null}
    </Card>
  );
}

function FlowStrip() {
  return (
    <Card>
      <CardTitle>Architecture flow</CardTitle>
      <div className="flex flex-wrap items-center gap-2">
        {FLOW.map((node, index) => (
          <span key={`${node}-${index}`} className="flex items-center gap-2">
            {index > 0 ? (
              <span aria-hidden="true" className="text-ink-3">
                →
              </span>
            ) : null}
            <span className="rounded-control border border-line bg-canvas px-2.5 py-1 text-[12px] text-ink-2">
              {node}
            </span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function InspectorPanels({ lastIO, chunks }: { lastIO: LastIO; chunks: number | null }) {
  const evidence = lastIO.evidence;
  const stream = lastIO.mode === "stream";
  const verdict = evidence.cache;

  const incoming = JSON.stringify(lastIO.payload, null, 2);
  const canonical = prettyJson(lastIO.canonical);

  const providerRequest = JSON.stringify(
    {
      request_id: evidence.requestId,
      lane: evidence.lane,
      key_id: evidence.keyId ?? null,
      provider: evidence.provider,
      cache_verdict: verdict,
      cache_hash: evidence.cacheHash,
      latency_ms: evidence.latencyMs,
      ttft_ms: stream ? (evidence.ttftMs ?? evidence.latencyMs) : (evidence.ttftMs ?? null),
      coalesced: evidence.coalesced ?? null,
      fallback: evidence.fallback ?? null,
      semantic_similarity: evidence.semanticSimilarity ?? null,
    },
    null,
    2,
  );

  const providerResponse = JSON.stringify(
    {
      mode: lastIO.mode,
      chunks: stream ? chunks : null,
      usage: lastIO.usage ?? null,
      error: lastIO.error ?? null,
    },
    null,
    2,
  );

  const preview =
    lastIO.text.length === 0
      ? "(empty response)"
      : lastIO.text.length > 480
        ? `${lastIO.text.slice(0, 480)}…`
        : lastIO.text;
  const finalText =
    lastIO.text.trim().length > 0 ? lastIO.text : (lastIO.error ?? "(empty response)");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InspectorPanel
        title="Incoming Request"
        caption="POST /v1/chat/completions · body as sent by the client"
      >
        <JsonBlock text={incoming} />
      </InspectorPanel>

      <InspectorPanel
        title="Canonical Request"
        caption="trimmed, key-sorted JSON · the gateway hashes this for the exact cache"
      >
        <JsonBlock text={canonical} />
      </InspectorPanel>

      <InspectorPanel
        title="Provider Request"
        badge={
          <span className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-ink-3">{evidence.provider ?? "—"}</span>
            <Badge tone={verdictTone(verdict)}>{verdict ?? "no verdict"}</Badge>
          </span>
        }
        caption="evidence headers from the reply · x-latency-ms is the TTFT when mode is stream"
      >
        <JsonBlock text={providerRequest} />
      </InspectorPanel>

      <InspectorPanel title="Provider Response" caption="usage and reply metadata from the provider lane">
        <JsonBlock text={providerResponse} />
      </InspectorPanel>

      <InspectorPanel
        title="Canonical Response"
        badge={
          lastIO.error ? (
            <Badge tone="miss">error response</Badge>
          ) : (
            <Badge tone="neutral">normalized by gateway</Badge>
          )
        }
        caption={lastIO.error ? undefined : "reply text preview · full text in Final Response"}
      >
        {lastIO.error ? (
          <p className="rounded-control border border-line bg-sunken p-3 text-[12px] leading-5 break-words whitespace-pre-wrap text-warn">
            {lastIO.error}
          </p>
        ) : (
          <p className="rounded-control border border-line bg-sunken p-3 text-[12px] leading-5 break-words whitespace-pre-wrap text-ink-2">
            {preview}
          </p>
        )}
      </InspectorPanel>

      <InspectorPanel title="Final Response" caption="exactly what the client received">
        <pre className="max-h-[280px] overflow-y-auto rounded-control border border-line bg-sunken p-3 text-[12px] leading-5 break-words whitespace-pre-wrap text-ink">
          {finalText}
        </pre>
      </InspectorPanel>
    </div>
  );
}

export function RequestInspector() {
  const { lastIO } = useAppStore();
  const clock = useClock(lastIO);
  const { at, chunks } = useMatchedMeta(lastIO);

  const clockMatches = clock !== null && clock.anchor === lastIO;
  const capturedAt = at ?? (clockMatches ? clock.capturedAt : null);
  const age =
    capturedAt !== null && clock !== null ? ageLabel(capturedAt, clock.now) : null;

  return (
    <PageShell
      title="Request Inspector"
      sub={`Incoming → canonical → provider → canonical → final · ${
        lastIO ? "last live request" : "no live request yet"
      }`}
      actions={age ? <span className="text-[12px] text-ink-3 tabular-nums">{age}</span> : undefined}
    >
      <FlowStrip />
      {lastIO ? (
        <InspectorPanels lastIO={lastIO} chunks={chunks} />
      ) : (
        <EmptyState
          icon={<IconRequests size={20} />}
          title={EMPTY_COPY}
          detail={
            <Link
              href="/playground"
              className="text-[12px] font-medium text-accent-ink hover:underline"
            >
              Open Playground
            </Link>
          }
        />
      )}
    </PageShell>
  );
}

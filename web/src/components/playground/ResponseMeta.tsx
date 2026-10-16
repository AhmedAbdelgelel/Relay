"use client";

/**
 * Compact strip for the last exchange: browser latency (plus the gateway's
 * own x-latency-ms), token I/O, estimated client-side cost and the cache
 * verdict + request-id chip. Every figure is dropped in when the reply lands.
 */

import type { ReactNode } from "react";
import type { CacheVerdict } from "@/lib/types";
import { Card, verdictTone, Badge } from "@/components/ui";
import { estimateCost, formatCost, formatLatency } from "@/lib/format";

/** Playground-scoped run summary (not persisted; rebuilt per request). */
export interface RunSummary {
  requestId: string;
  model: string;
  provider: string | null;
  verdict: CacheVerdict | null;
  /** Browser-measured latency for the whole call. */
  latencyMs: number;
  /** x-latency-ms: whole request (JSON) or TTFT (stream). */
  gwMs: number | null;
  ttftMs: number | null;
  chunks: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimated: boolean;
  /** ISO timestamp of the reply. */
  at: string;
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="mt-0.5 truncate text-[13px] text-ink tabular-nums">{children}</div>
    </div>
  );
}

export function ResponseMeta({ summary }: { summary: RunSummary | null }) {
  const hasTokens = summary !== null && summary.promptTokens !== null && summary.completionTokens !== null;
  const cost =
    summary !== null && hasTokens
      ? formatCost(
          estimateCost(summary.model, {
            prompt: summary.promptTokens ?? 0,
            completion: summary.completionTokens ?? 0,
          }),
        )
      : "—";

  return (
    <Card padded={false} className="p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cell label="Latency">
          {summary
            ? `${formatLatency(summary.latencyMs)}${
                summary.gwMs !== null ? ` · gw ${summary.gwMs}ms` : ""
              }`
            : "—"}
        </Cell>
        <Cell label="Tokens">
          {hasTokens ? `${summary.promptTokens} in · ${summary.completionTokens} out` : "—"}
        </Cell>
        <Cell label="Cost">{cost}</Cell>
        <Cell label="Cache">
          {summary?.verdict ? (
            <span className="flex items-center gap-2">
              <Badge tone={verdictTone(summary.verdict)}>{summary.verdict}</Badge>
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-3"
                title={summary.requestId}
              >
                {summary.requestId.slice(0, 8)}
              </span>
            </span>
          ) : (
            "—"
          )}
        </Cell>
      </div>
    </Card>
  );
}

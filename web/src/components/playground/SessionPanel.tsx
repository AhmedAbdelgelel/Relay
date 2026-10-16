"use client";

/**
 * Session panel: the 16 legacy counters with FIXED semantics — semantic hits
 * and the semantic rate are live (rough edges #1/#2), HIT + SEMANTIC_HIT both
 * count as hits with reused tokens, DISABLED and BYPASS have their own
 * buckets, and the average latency excludes errored/aborted calls (rough edge
 * #7: those are recorded without a latency sample).
 *
 * data flow: everything is folded by `applyStats` in lib/store; this component
 * only formats.
 */

import { IconChevronDown } from "@/components/ui/icons";
import { formatCount, formatLatency } from "@/lib/format";
import type { SessionStats } from "@/lib/types";

function Cell({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-[13px] font-semibold text-ink tabular-nums">{value}</div>
      <div className="truncate text-[11px] text-ink-3">{label}</div>
    </div>
  );
}

export function SessionPanel({ stats }: { stats: SessionStats }) {
  const decided = stats.hits + stats.misses;
  const rate = decided > 0 ? `${Math.round((stats.hits / decided) * 100)}%` : "—";
  const semanticDecided = stats.semanticHits + stats.misses;
  const semanticRate =
    semanticDecided > 0 ? `${Math.round((stats.semanticHits / semanticDecided) * 100)}%` : "—";
  const completed = stats.requests - stats.errors;
  const avgLatency = completed > 0 ? formatLatency(stats.latencyMsTotal / completed) : "—";
  const avgTtft = stats.ttftCount > 0 ? `${Math.round(stats.ttftMsTotal / stats.ttftCount)}ms` : "—";
  const totalTokens = stats.promptTokens + stats.completionTokens;

  const summary =
    stats.requests > 0
      ? `${stats.estimated ? "≈ " : ""}${stats.requests} requests (${stats.bypassed} streamed) · ${rate} HIT · ${formatCount(totalTokens)} tokens${
          stats.errors ? ` · ${stats.errors} error${stats.errors > 1 ? "s" : ""}` : ""
        }`
      : "No requests yet";

  return (
    <details className="group rounded-card border border-line bg-surface shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 text-[13px] font-medium text-ink">Session</span>
        <span className="flex min-w-0 items-center gap-2">
          <span aria-live="polite" className="truncate text-[12px] text-ink-3 tabular-nums">
            {summary}
          </span>
          <IconChevronDown
            size={14}
            className="shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line p-4 sm:grid-cols-4">
        <Cell value={formatCount(stats.requests)} label="requests" />
        <Cell
          value={formatCount(stats.hits)}
          label="hits"
          title="HIT + SEMANTIC_HIT — the provider was not called"
        />
        <Cell value={formatCount(stats.misses)} label="misses" title="exact cache misses" />
        <Cell value={rate} label="hit rate" />
        <Cell value={formatCount(stats.semanticHits)} label="semantic hits" />
        <Cell
          value={semanticRate}
          label="semantic rate"
          title="SEMANTIC_HIT / (SEMANTIC_HIT + exact misses)"
        />
        <Cell value={formatCount(stats.bypassed)} label="streams bypassed" />
        <Cell value={formatCount(stats.disabled)} label="cache disabled" />
        <Cell value={formatCount(stats.errors)} label="errors" />
        <Cell
          value={formatCount(stats.hits)}
          label="provider calls saved"
          title="one per hit — a cache answer never reaches the provider"
        />
        <Cell value={formatCount(stats.promptTokens)} label="tokens in" />
        <Cell value={formatCount(stats.completionTokens)} label="tokens out" />
        <Cell value={formatCount(stats.reusedTokens)} label="tokens reused" />
        <Cell value={formatCount(stats.chunks)} label="stream chunks" />
        <Cell
          value={avgLatency}
          label="avg latency"
          title="completed requests only (errors and aborts excluded)"
        />
        <Cell value={avgTtft} label="avg TTFT" />
      </div>
    </details>
  );
}

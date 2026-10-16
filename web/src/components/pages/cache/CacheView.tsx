"use client";

/**
 * Cache (inventory §2.4): six live stat cards from GET /metrics, an extended
 * metrics strip (rough edge #17: tokens, cost saved, fallbacks, breaker,
 * histograms), and the two configuration inspectors.
 *
 * Zeroes before any traffic — never demo numbers.
 */

import { Badge, Card, CardTitle, StatCard } from "@/components/ui";
import { CacheInspectors } from "@/components/pages/cache/CacheInspectors";
import { PageShell } from "@/components/pages/shared/PageShell";
import { cn } from "@/lib/cn";
import { formatCost, formatCount, formatLatency, formatRate, percent } from "@/lib/format";
import { useAppStore } from "@/lib/store";
import { EMPTY_METRICS, type MetricsSnapshot } from "@/lib/types";

function LiveStat({
  value,
  label,
  warn = false,
}: {
  value: string;
  label: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "truncate text-[13px] font-semibold tabular-nums",
          warn ? "text-warn" : "text-ink",
        )}
      >
        {value}
      </div>
      <div className="truncate font-mono text-[11px] text-ink-3">{label}</div>
    </div>
  );
}

interface StatEntry {
  label: string;
  value: string;
  detail: string;
  warn?: boolean;
}

/** The six legacy cacheCards(), in order (public/js/app.js cacheCards). */
function cacheStats(m: MetricsSnapshot): StatEntry[] {
  const decided = m.exact_hits + m.exact_misses;
  const semDecided = m.semantic_hits + m.semantic_misses;
  const errors = m.cache_lookup_failed + m.cache_write_failed + m.semantic_errors;
  return [
    {
      label: "Exact Hit Rate",
      value: decided > 0 ? formatRate(percent(m.exact_hits, decided)) : "--",
      detail: `${formatCount(m.exact_hits)} hit / ${formatCount(m.exact_misses)} miss`,
    },
    {
      label: "Semantic Hit Rate",
      value: semDecided > 0 ? formatRate(percent(m.semantic_hits, semDecided)) : "--",
      detail: `${formatCount(m.semantic_hits)} hit / ${formatCount(m.semantic_misses)} miss`,
    },
    {
      label: "Provider Calls Avoided",
      value: formatCount(m.provider_calls_avoided),
      detail: `${formatCount(m.exact_hits)} exact + ${formatCount(m.singleflight_coalesced)} coalesced`,
    },
    {
      label: "Mean Similarity",
      value: m.avg_semantic_score > 0 ? String(Number(m.avg_semantic_score.toFixed(4))) : "--",
      detail: "cosine of accepted hits",
    },
    {
      label: "Exact Lookup",
      value: m.cache_lookups > 0 ? `${Math.round(m.avg_cache_lookup_ms)}ms` : "--",
      detail: "avg get() latency",
    },
    {
      label: "Cache Errors",
      value: formatCount(errors),
      detail: `${formatCount(m.cache_lookup_failed)} read / ${formatCount(m.cache_write_failed)} write / ${formatCount(
        m.semantic_errors,
      )} semantic`,
      warn: errors > 0,
    },
  ];
}

export function CacheView() {
  const { health, metrics, offline } = useAppStore();
  const m = metrics ?? EMPTY_METRICS;

  return (
    <PageShell
      title="Cache"
      sub="Exact first, semantic on MISS, policy gate before every reuse"
      actions={
        <Badge
          tone={offline ? "disabled" : "neutral"}
          title={
            offline
              ? "Polling failed — showing the last known snapshot"
              : "Refreshing from /metrics every 30s"
          }
        >
          live /metrics
        </Badge>
      }
    >
      <div aria-live="polite" className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {cacheStats(m).map((card) => (
            <StatCard
              key={card.label}
              label={card.label}
              value={card.warn ? <span className="text-warn">{card.value}</span> : card.value}
              detail={card.detail}
            />
          ))}
        </div>

        <Card>
          <CardTitle>Extended metrics</CardTitle>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <LiveStat value={formatCount(m.tokens_in)} label="tokens_in" />
            <LiveStat value={formatCount(m.tokens_out)} label="tokens_out" />
            <LiveStat value={formatCost(m.estimated_cost_saved)} label="estimated_cost_saved" />
            <LiveStat value={formatCount(m.fallback_count)} label="fallback_count" />
            <LiveStat
              value={formatCount(m.breaker_open)}
              label="breaker_open"
              warn={m.breaker_open > 0}
            />
            <LiveStat value={formatCount(m.cache_lookups)} label="cache_lookups" />
            <LiveStat value={formatCount(m.semantic_lookups)} label="semantic_lookups" />
            <LiveStat
              value={m.provider_requests > 0 ? formatLatency(m.avg_provider_ms) : "--"}
              label="avg_provider_ms"
            />
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <div className="text-[11px] text-ink-3">accepted-hit similarity histogram</div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <LiveStat value={formatCount(m.semantic_hist_lt_090)} label={"< 0.90"} />
              <LiveStat value={formatCount(m.semantic_hist_090_092)} label="0.90–0.92" />
              <LiveStat value={formatCount(m.semantic_hist_092_095)} label="0.92–0.95" />
              <LiveStat value={formatCount(m.semantic_hist_gte_095)} label="≥ 0.95" />
            </div>
          </div>
        </Card>
      </div>

      <CacheInspectors health={health} />

      <p className="text-[12px] leading-5 text-ink-3">
        Every verdict is returned on the response as <span className="font-mono">x-cache</span>, so
        a client can always prove why it hit or missed. Tuning is server-side (
        <span className="font-mono">CACHE_TTL_S</span>,{" "}
        <span className="font-mono">SEMANTIC_THRESHOLD</span>) and never reaches the browser.
      </p>
    </PageShell>
  );
}

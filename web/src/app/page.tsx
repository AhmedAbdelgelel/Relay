"use client";

/**
 * Overview — every figure comes from GET /metrics or is measured in this
 * browser session. A cold gateway honestly reports zeros; nothing here is
 * fabricated (inventory §2.1).
 */

import Link from "next/link";
import {
  Badge,
  buttonClasses,
  Card,
  CardTitle,
  StatCard,
  Table,
  TBody,
  TD,
  TR,
} from "@/components/ui";
import { IconChevronDown } from "@/components/ui/icons";
import { formatCount, formatLatency, formatRate, percent } from "@/lib/format";
import { useAppStore } from "@/lib/store";
import { EMPTY_METRICS, type MetricsSnapshot } from "@/lib/types";

const PIPELINE = [
  "Request",
  "Canonicalization",
  "Exact Cache",
  "Semantic Cache",
  "Policy",
  "Provider",
];

/** The 17 rows of the legacy metricRows() table, in order. */
function metricRows(m: MetricsSnapshot): Array<[string, string]> {
  const int = (n: number) => n.toLocaleString("en-US");
  const trimmed = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  return [
    ["requests_total", int(m.requests_total)],
    ["provider_requests", int(m.provider_requests)],
    ["provider_errors", int(m.provider_errors)],
    ["exact_hits", int(m.exact_hits)],
    ["exact_misses", int(m.exact_misses)],
    ["semantic_hits", int(m.semantic_hits)],
    ["semantic_misses", int(m.semantic_misses)],
    ["semantic_errors", int(m.semantic_errors)],
    ["semantic_lookups", int(m.semantic_lookups)],
    ["avg_semantic_score", trimmed(m.avg_semantic_score, 4)],
    ["provider_calls_avoided", int(m.provider_calls_avoided)],
    ["singleflight_coalesced", int(m.singleflight_coalesced)],
    ["singleflight_leaders", int(m.singleflight_leaders)],
    ["cache_lookup_failed", int(m.cache_lookup_failed)],
    ["cache_write_failed", int(m.cache_write_failed)],
    ["avg_cache_lookup_ms", trimmed(m.avg_cache_lookup_ms, 2)],
    ["avg_provider_ms", trimmed(m.avg_provider_ms, 2)],
  ];
}

function LiveStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-semibold text-ink tabular-nums">{value}</div>
      <div className="text-[11px] text-ink-3">{label}</div>
    </div>
  );
}

export default function OverviewPage() {
  const { health, metrics, stats, status } = useAppStore();
  const m = metrics ?? EMPTY_METRICS;

  const decided = m.exact_hits + m.exact_misses;
  const semDecided = m.semantic_hits + m.semantic_misses;
  const successRate =
    m.requests_total > 0 ? (1 - m.provider_errors / m.requests_total) * 100 : null;
  const sessionTokens = stats.promptTokens + stats.completionTokens;

  return (
    <div className="page-enter mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-5 py-6 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold text-ink">LLM Gateway</h1>
          <p className="mt-1 text-[13px] text-ink-2">Unified interface for multiple LLM providers</p>
        </div>
        <div className="flex items-center gap-3">
          {status === "offline" || status === "error" ? (
            <Badge tone="bypass" title="Health polling failed — showing the last known snapshot">
              offline · last snapshot
            </Badge>
          ) : null}
          <Link href="/playground" className={buttonClasses("primary", "md")}>
            Open Playground
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Requests"
          value={formatCount(m.requests_total)}
          detail={`${formatCount(m.provider_requests)} provider calls`}
        />
        <StatCard
          label="Success Rate"
          value={successRate === null ? "--" : formatRate(successRate)}
          detail={`${formatCount(m.provider_errors)} provider errors`}
        />
        <StatCard
          label="Avg Provider Latency"
          value={m.provider_requests > 0 ? formatLatency(m.avg_provider_ms) : "--"}
          detail="upstream round trip"
        />
        <StatCard
          label="Tokens (session)"
          value={formatCount(sessionTokens)}
          detail={`${formatCount(stats.promptTokens)} in · ${formatCount(stats.completionTokens)} out${
            stats.estimated ? " (est)" : ""
          }`}
        />
        <StatCard
          label="Exact Hit Rate"
          value={decided > 0 ? formatRate(percent(m.exact_hits, decided)) : "--"}
          detail={`${formatCount(m.exact_hits)} hit · ${formatCount(m.exact_misses)} miss`}
        />
        <StatCard
          label="Semantic Hit Rate"
          value={semDecided > 0 ? formatRate(percent(m.semantic_hits, semDecided)) : "--"}
          detail={`${formatCount(m.semantic_hits)} hit · ${formatCount(m.semantic_misses)} miss`}
        />
      </div>

      <Card>
        <CardTitle>This browser session</CardTitle>
        <div
          aria-live="polite"
          className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4"
        >
          <LiveStat value={formatCount(stats.requests)} label="requests" />
          <LiveStat value={formatCount(sessionTokens)} label="tokens" />
          <LiveStat
            value={`${stats.hits} hits / ${stats.semanticHits} semantic / ${stats.misses} miss / ${stats.bypassed} bypass`}
            label="cache verdicts"
          />
          <LiveStat value={formatCount(stats.errors)} label="errors" />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Cache lookup pipeline</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {PIPELINE.map((node, index) => (
              <span key={node} className="flex items-center gap-2">
                {index > 0 ? (
                  <IconChevronDown size={14} className="-rotate-90 text-ink-3" />
                ) : null}
                <span className="rounded-control border border-line bg-canvas px-2.5 py-1 text-[12px] text-ink-2">
                  {node}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-5 text-ink-3">
            Exact first. On MISS the request is embedded and searched for near-duplicates; the
            policy gate decides whether reuse is safe before any answer is returned.
          </p>
          <p className="mt-2 text-[12px] text-ink-3">
            Cache store: <span className="font-mono">{health?.cache ?? "—"}</span> · semantic:{" "}
            <span className="font-mono">{health?.semantic ?? "—"}</span>
          </p>
        </Card>

        <Card padded={false} className="overflow-hidden">
          <div className="p-5 pb-3">
            <CardTitle className="mb-0">Gateway metrics</CardTitle>
          </div>
          <div className="max-h-[360px] overflow-y-auto px-2 pb-2">
            <Table>
              <TBody>
                {metricRows(m).map(([key, value]) => (
                  <TR key={key}>
                    <TD className="py-1.5 font-mono text-[12px] text-ink-2">{key}</TD>
                    <TD className="py-1.5 text-right font-mono text-[12px] text-ink tabular-nums">
                      {value}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}

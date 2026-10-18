"use client";

/**
 * Settings — the home for the connection and the Advanced section.
 *
 * Advanced gates every technical surface: with it off the playground shows a
 * clean chat (no metrics lines, evidence cards, trace or session counters).
 * The last captured exchange and the gateway's cache configuration live here
 * so the chat surface stays simple, and the deep inspector routes are linked.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, CardTitle, Switch } from "@/components/ui";
import { IconExternal } from "@/components/ui/icons";
import { ConnectionFields } from "@/components/playground/ConnectionFields";
import { PageShell } from "@/components/pages/shared/PageShell";
import { cn } from "@/lib/cn";
import { formatLatency } from "@/lib/format";
import { useAppStore } from "@/lib/store";

function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className={cn("truncate text-[12px] text-ink", mono && "font-mono")}>{children}</span>
    </div>
  );
}

function JsonBlock({ title, body }: { title: string; body: string }) {
  return (
    <details className="overflow-hidden rounded-control border border-line bg-canvas">
      <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-medium text-ink-2 select-none">
        {title}
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-line px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink-2">
        {body}
      </pre>
    </details>
  );
}

const STATUS_TONE = {
  checking: "neutral",
  online: "hit",
  offline: "miss",
  error: "miss",
} as const;

export function SettingsView() {
  const { connection, advanced, setAdvanced, health, status, lastIO } = useAppStore();
  const config = health?.config;
  const registered = connection.apiKey.trim() !== "";

  return (
    <PageShell
      title="Settings"
      sub="Connection and the Advanced section — everything technical about chat, context and cache."
    >
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Connection</CardTitle>
          <ConnectionFields />
          <div className="mt-2">
            <Row label="Gateway status">
              <Badge tone={STATUS_TONE[status]}>{status}</Badge>
            </Row>
            <Row label="Lane">
              <Badge tone={registered ? "accent" : "bypass"}>
                {registered ? "registered key" : "try-out — anonymous"}
              </Badge>
            </Row>
            <Row label="Default provider" mono>
              {health?.provider ?? "—"}
            </Row>
            <Row label="Cache backend" mono>
              {health?.cache ?? "—"}
            </Row>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-ink-3">
            No key? Requests use the anonymous try-out lane — it always bypasses the cache. Register
            a provider key on{" "}
            <Link
              href="/providers"
              className="text-accent-ink underline decoration-dotted underline-offset-2"
            >
              Providers
            </Link>{" "}
            to unlock caching and account-scoped usage.
          </p>
        </Card>

        <Card>
          <CardTitle>Advanced</CardTitle>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p id="advanced-label" className="text-[12px] font-medium text-ink">
                Show technical details
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-ink-3">
                In the playground: per-reply metrics, the cache-evidence card, the request trace
                and the session counters. Off, the playground is just the chat.
              </p>
            </div>
            <Switch
              checked={advanced}
              onToggle={() => setAdvanced(!advanced)}
              labelledBy="advanced-label"
            />
          </div>
          <div className="mt-3 border-t border-line pt-2">
            <Row label="Last exchange captured">
              {lastIO ? <span className="font-mono">{lastIO.payload.model}</span> : "—"}
            </Row>
            <Row label="Inspect deeper">
              <span className="flex items-center gap-3">
                <Link
                  href="/cache"
                  className="inline-flex items-center gap-1 text-accent-ink underline decoration-dotted underline-offset-2"
                >
                  Cache <IconExternal size={11} />
                </Link>
                <Link
                  href="/requests"
                  className="inline-flex items-center gap-1 text-accent-ink underline decoration-dotted underline-offset-2"
                >
                  Requests <IconExternal size={11} />
                </Link>
              </span>
            </Row>
          </div>
        </Card>
      </div>

      <Card>
        <CardTitle>Last exchange</CardTitle>
        {lastIO ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
              <Badge tone={lastIO.evidence.cache === "HIT" ? "hit" : lastIO.evidence.cache === "SEMANTIC_HIT" ? "semantic" : lastIO.evidence.cache === "MISS" ? "miss" : "bypass"}>
                {lastIO.evidence.cache ?? "—"}
              </Badge>
              <span>
                model <span className="font-mono text-ink">{lastIO.payload.model}</span>
              </span>
              <span>
                mode <span className="font-mono text-ink">{lastIO.mode}</span>
              </span>
              {lastIO.usage ? (
                <span className="tabular-nums">
                  tokens <span className="font-mono text-ink">{lastIO.usage.prompt_tokens}</span>+
                  <span className="font-mono text-ink">{lastIO.usage.completion_tokens}</span>
                </span>
              ) : null}
              {typeof lastIO.evidence.latencyMs === "number" ? (
                <span className="tabular-nums">
                  gateway{" "}
                  <span className="font-mono text-ink">
                    {formatLatency(lastIO.evidence.latencyMs)}
                  </span>
                </span>
              ) : null}
              {lastIO.evidence.requestId ? (
                <span className="font-mono text-[11px] text-ink-3" title={lastIO.evidence.requestId}>
                  {lastIO.evidence.requestId.slice(0, 8)}
                </span>
              ) : null}
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              <JsonBlock title="Request payload" body={JSON.stringify(lastIO.payload, null, 2)} />
              <JsonBlock title="Canonical form (cache identity)" body={lastIO.canonical} />
            </div>
            <JsonBlock
              title={lastIO.error ? "Error" : "Response"}
              body={lastIO.error ?? lastIO.text}
            />
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">
            No exchange captured yet — send one from the Playground and it lands here.
          </p>
        )}
      </Card>

      <Card>
        <CardTitle
          actions={
            <span className="text-[11px] text-ink-3">
              from <span className="font-mono">GET /health</span>
            </span>
          }
        >
          Cache configuration
        </CardTitle>
        {config ? (
          <div className="grid gap-x-6 lg:grid-cols-2">
            <div>
              <Row label="Exact cache">
                <Badge tone={config.cacheEnabled ? "hit" : "disabled"}>
                  {config.cacheEnabled ? "enabled" : "disabled"}
                </Badge>
              </Row>
              <Row label="Exact TTL" mono>
                {config.cacheTtlSec}s
              </Row>
              <Row label="Cache backend" mono>
                {health?.cache ?? "—"}
              </Row>
              <Row label="Upstream timeout" mono>
                {config.upstreamTimeoutMs} ms
              </Row>
            </div>
            <div>
              <Row label="Semantic cache">
                <Badge tone={config.semanticEnabled ? "semantic" : "disabled"}>
                  {config.semanticEnabled ? "enabled" : "disabled"}
                </Badge>
              </Row>
              <Row label="Similarity threshold" mono>
                {config.semanticThreshold}
              </Row>
              <Row label="Top-K lookups" mono>
                {config.semanticTopK}
              </Row>
              <Row label="Semantic TTL" mono>
                {config.semanticTtlSec}s
              </Row>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">
            Gateway offline — configuration appears once <span className="font-mono">/health</span>{" "}
            responds.
          </p>
        )}
      </Card>
    </PageShell>
  );
}

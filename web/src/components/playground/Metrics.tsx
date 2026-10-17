"use client";

/**
 * Assistant request metrics: the compact verdict line plus the collapsible
 * evidence card (legacy buildMetricsCard(), extended to fix rough edges #2
 * (SEMANTIC_HIT badge + similarity hint) and #3 (lane / key id / coalesced /
 * fallback / similarity row) and #20 (ms-precision latency).
 *
 * Honesty invariants kept: the canonical preview is the exact sorted-key JSON
 * the gateway hashes, the browser re-hashes it (effect-only, never render) and
 * compares with x-cache-hash, and estimated token counts stay marked with ≈.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CacheVerdict, Evidence, MessageMeta } from "@/lib/types";
import { Badge, verdictTone } from "@/components/ui";
import { IconChevronDown } from "@/components/ui/icons";
import { exactCacheKey, sha256Hex } from "@/lib/canonical";
import { formatLatency, timeShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import { cacheHint } from "./catalog";
import { copyText } from "./clipboard";

/* ── line ────────────────────────────────────────────────────────────────── */

function lineTone(verdict: CacheVerdict | null): string {
  switch (verdict) {
    case "HIT":
      return "text-ok";
    case "SEMANTIC_HIT":
      return "text-accent-ink";
    case "MISS":
      return "text-warn";
    default:
      return "text-ink-3";
  }
}

/** Legacy metricsLine() shape, ms precision under a second. */
export function metricsLineText(meta: MessageMeta): string {
  const approx = meta.estimated ? "≈" : "";
  const parts: string[] = [formatLatency(meta.latencyMs)];
  if (meta.chunks !== undefined && meta.ttftMs !== undefined) {
    parts.push(`ttft ${formatLatency(meta.ttftMs)}`);
  }
  if (meta.promptTokens !== undefined || meta.completionTokens !== undefined) {
    parts.push(
      `${approx}${meta.promptTokens ?? 0} in · ${approx}${meta.completionTokens ?? 0} out`,
    );
  }
  if (meta.chunks) parts.push(`${meta.chunks} chunks`);
  if (meta.verdict) parts.push(`cache ${meta.verdict}`);
  if (meta.model) parts.push(meta.model);
  return parts.join(" · ");
}

export function MetricsLine({
  meta,
  open,
  cardId,
  onToggle,
}: {
  meta: MessageMeta;
  open: boolean;
  cardId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={cardId}
      title="Request metrics — click for the full breakdown"
      className={cn(
        "mt-1 flex max-w-full items-center gap-1 text-left text-[11px] tabular-nums",
        lineTone(meta.verdict),
      )}
    >
      <span className="truncate">{metricsLineText(meta)}</span>
      <IconChevronDown
        size={12}
        className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
      />
    </button>
  );
}

/* ── card ────────────────────────────────────────────────────────────────── */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 border-b border-line py-2 last:border-0">
      <span className="text-[11px] leading-5 text-ink-3">{label}</span>
      <div className="min-w-0 text-[12px] leading-5 text-ink">{children}</div>
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-[11px] leading-4 text-ink-3">{children}</div>;
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const timer = useRef<number | null>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = () => {
    void copyText(text).then((ok) => {
      setState(ok ? "copied" : "failed");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className="ml-2 shrink-0 rounded-[6px] border border-line px-1.5 py-0.5 text-[10px] text-ink-3 transition-colors duration-150 hover:bg-wash hover:text-ink"
    >
      {state === "copied" ? "copied" : state === "failed" ? "failed" : "copy"}
    </button>
  );
}

type VerifyState = "idle" | "ok" | "bad" | "unavailable" | "nohash" | "nocanonical";

const VERIFY_TEXT: Record<VerifyState, string> = {
  idle: "sha256…",
  ok: "✓ browser sha256 matches x-cache-hash",
  bad: "✗ browser sha256 differs from gateway",
  unavailable: "sha256 unavailable in this context",
  nohash: "gateway sent no hash to compare",
  nocanonical: "—",
};

function VerifyChip({ canonical, hash }: { canonical: string | undefined; hash: string | undefined }) {
  const [state, setState] = useState<VerifyState>(
    canonical ? (hash ? "idle" : "nohash") : "nocanonical",
  );

  // crypto.subtle runs in an effect, never during render.
  useEffect(() => {
    if (!canonical || !hash) return;
    let cancelled = false;
    void sha256Hex(canonical).then((local) => {
      if (cancelled) return;
      setState(local === null ? "unavailable" : local === hash ? "ok" : "bad");
    });
    return () => {
      cancelled = true;
    };
  }, [canonical, hash]);

  return (
    <span
      className={cn(
        "text-[11px]",
        state === "ok" ? "text-ok" : state === "bad" ? "text-err" : "text-ink-3",
      )}
    >
      {VERIFY_TEXT[state]}
    </span>
  );
}

function tokensPerSecond(meta: MessageMeta): number | null {
  if (meta.completionTokens === undefined) return null;
  if (meta.latencyMs === null || meta.latencyMs <= 0) return null;
  const generating = Math.max(meta.latencyMs - (meta.ttftMs ?? 0), 1);
  return Math.round((meta.completionTokens / generating) * 1000);
}

export function MetricsCard({
  meta,
  evidence,
  id,
  open,
}: {
  meta: MessageMeta;
  evidence: Evidence | undefined;
  id: string;
  open: boolean;
}) {
  const streamed = meta.chunks !== undefined;
  const hasTokens = meta.promptTokens !== undefined || meta.completionTokens !== undefined;
  const speed = tokensPerSecond(meta);
  const gwMs = evidence?.latencyMs ?? null;
  const hash = meta.cacheHash;
  const provider = evidence?.provider ?? meta.provider;
  const cacheKey = hash ? exactCacheKey(provider ?? "unknown", hash) : null;

  const routing: string[] = [];
  if (evidence?.keyId) routing.push(`key ${evidence.keyId}`);
  if (evidence?.coalesced !== null && evidence?.coalesced !== undefined) {
    routing.push(`coalesced ${evidence.coalesced}`);
  }
  if (evidence?.fallback === true) routing.push("fallback true");
  if (evidence?.semanticSimilarity !== null && evidence?.semanticSimilarity !== undefined) {
    routing.push(`similarity ${evidence.semanticSimilarity.toFixed(4)}`);
  }

  return (
    <div id={id} hidden={!open} className="mt-2 rounded-control border border-line bg-canvas p-3">
      <Row label="Cache">
        {meta.verdict ? (
          <>
            <Badge tone={verdictTone(meta.verdict)}>{meta.verdict}</Badge>
            <Sub>{cacheHint(meta.verdict, evidence?.semanticSimilarity, evidence?.lane)}</Sub>
          </>
        ) : (
          <span className="text-ink-3">not classified (request failed)</span>
        )}
      </Row>

      <Row label="Cache key">
        {cacheKey ? (
          <span className="flex items-start">
            <span className="min-w-0 font-mono text-[11px] break-all">{cacheKey}</span>
            <CopyChip text={cacheKey} label="Copy cache key" />
          </span>
        ) : (
          <span className="text-ink-3">— (no x-cache-hash header)</span>
        )}
      </Row>

      <Row label="Canonical">
        {meta.canonical ? (
          <>
            <VerifyChip canonical={meta.canonical} hash={hash} />
            <pre className="mt-1 max-h-40 overflow-auto rounded-control bg-sunken p-2 font-mono text-[11px] leading-4 break-words whitespace-pre-wrap text-ink-2">
              {meta.canonical}
            </pre>
          </>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </Row>

      <Row label="Latency">
        {meta.latencyMs !== null ? `${Math.round(meta.latencyMs)} ms` : "—"}
        {gwMs !== null ? (
          <Sub>
            gateway {gwMs} ms ({streamed ? "first token" : "whole request"})
          </Sub>
        ) : null}
      </Row>

      {streamed ? (
        <Row label="TTFT">
          {meta.ttftMs !== undefined ? formatLatency(meta.ttftMs) : "—"}
          <Sub>time to first token, measured in the browser</Sub>
        </Row>
      ) : null}

      <Row label="Tokens">
        {hasTokens ? (
          <>
            {meta.promptTokens ?? 0} in · {meta.completionTokens ?? 0} out
            {meta.estimated ? (
              <Sub>≈ estimated (~4 chars/token) — provider reported no usage</Sub>
            ) : null}
          </>
        ) : (
          <span className="text-ink-3">— (no usage reported)</span>
        )}
      </Row>

      {speed !== null ? (
        <Row label="Speed">
          {speed} tok/s
          <Sub>completion tokens / generating time</Sub>
        </Row>
      ) : null}

      {streamed ? (
        <Row label="Stream">
          {meta.chunks ?? 0} chunks · SSE
          <Sub>cache bypassed — the numbers above come from this connection only</Sub>
        </Row>
      ) : null}

      <Row label="Lane">
        {evidence?.lane ?? <span className="text-ink-3">—</span>}
        {routing.length > 0 ? <Sub>{routing.join(" · ")}</Sub> : null}
      </Row>

      <Row label="Provider">
        {provider ?? "—"} · {meta.model || "—"}
      </Row>

      <Row label="Request">
        <span className="font-mono text-[11px] break-all">{meta.requestId}</span>
        <Sub>{timeShort(meta.at)}</Sub>
      </Row>
    </div>
  );
}

"use client";

/**
 * Request Trace: the 8 legacy pipeline steps (config.js TRACE_STEPS) with an
 * expandable JSON snippet per step. While a request runs the first step is
 * highlighted (the gateway exposes no per-step telemetry, so nothing beyond
 * that is claimed); once a reply lands every step is marked done.
 */

import { useState } from "react";
import { Card, CardTitle } from "@/components/ui";
import { IconChevronDown } from "@/components/ui/icons";
import { canonicalizePayload } from "@/lib/canonical";
import { formatLatency } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useAppStore } from "@/lib/store";
import type { ChatPayload } from "@/lib/types";
import { PROVIDERS, TRACE_STEPS } from "./catalog";
import { type RunSummary } from "./ResponseMeta";

function traceSnippet(
  index: number,
  payload: ChatPayload | null,
  summary: RunSummary | null,
  providerId: string,
  timeoutMs: number | null,
): string {
  const requestId = summary?.requestId ?? "pending";
  const provider = summary?.provider ?? providerId;
  const info = PROVIDERS[provider];
  switch (index) {
    case 0:
      return JSON.stringify(
        { method: "POST", path: "/v1/chat/completions", "x-request-id": requestId },
        null,
        2,
      );
    case 1:
      return JSON.stringify(
        { validated: true, timeout_ms: timeoutMs, request_id: requestId },
        null,
        2,
      );
    case 2:
      return payload ? canonicalizePayload(payload) : "{}";
    case 3:
      return JSON.stringify(
        { provider, adapter: info?.adapter ?? "—", model: payload?.model ?? "…" },
        null,
        2,
      );
    case 4:
      return JSON.stringify(
        { endpoint: info?.endpoint ?? "—", stream: payload?.stream ?? false },
        null,
        2,
      );
    case 5:
      return JSON.stringify(
        {
          status: summary ? "200" : "pending",
          latency_ms: summary ? Math.round(summary.latencyMs) : null,
          ttft_ms: summary?.ttftMs ?? null,
        },
        null,
        2,
      );
    case 6:
      return JSON.stringify(
        {
          normalized: summary !== null,
          usage:
            summary && summary.promptTokens !== null
              ? {
                  prompt_tokens: summary.promptTokens,
                  completion_tokens: summary.completionTokens ?? 0,
                }
              : "pending",
          cache: summary?.verdict ?? "…",
        },
        null,
        2,
      );
    case 7:
      return JSON.stringify(
        { delivered: summary !== null, cache: summary?.verdict ?? "…", request_id: requestId },
        null,
        2,
      );
    default:
      return "{}";
  }
}

export function RequestTrace({
  payload,
  summary,
  running,
  providerId,
}: {
  payload: ChatPayload | null;
  summary: RunSummary | null;
  running: boolean;
  providerId: string;
}) {
  const { health } = useAppStore();
  const [openStep, setOpenStep] = useState<number | null>(null);
  const timeoutMs = health?.config?.upstreamTimeoutMs ?? null;

  return (
    <Card>
      <CardTitle>Request Trace</CardTitle>
      <ol className="flex flex-col">
        {TRACE_STEPS.map((step, index) => {
          const done = summary !== null;
          const active = !done && running && index === 0;
          const open = openStep === index;
          const bodyId = `trace-step-${index}`;
          return (
            <li key={`${step}-${index}`} className="border-b border-line last:border-0">
              <button
                type="button"
                onClick={() => setOpenStep(open ? null : index)}
                aria-expanded={open}
                aria-controls={bodyId}
                className="flex w-full items-center gap-2.5 py-2 text-left"
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-[6px] text-[10px] font-medium tabular-nums",
                    done
                      ? "bg-ok-soft text-ok"
                      : active
                        ? "bg-accent-soft text-accent-ink"
                        : "bg-neutral-soft text-ink-3",
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12px]",
                    done ? "text-ink-2" : active ? "font-medium text-ink" : "text-ink-3",
                  )}
                >
                  {step}
                </span>
                {done && index === 5 ? (
                  <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">
                    {formatLatency(summary.latencyMs)}
                  </span>
                ) : null}
                <IconChevronDown
                  size={12}
                  className={cn(
                    "shrink-0 text-ink-3 transition-transform duration-150",
                    open && "rotate-180",
                  )}
                />
              </button>
              <div id={bodyId} hidden={!open} className="pb-2">
                <pre className="max-h-48 overflow-auto rounded-control bg-sunken p-2 font-mono text-[11px] leading-4 break-words whitespace-pre-wrap text-ink-2">
                  {traceSnippet(index, payload, summary, providerId, timeoutMs)}
                </pre>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

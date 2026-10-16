"use client";

import { useState } from "react";
import { Badge, Card, type BadgeTone } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface ProviderCardData {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  configured: boolean;
  active: boolean;
}

export type ProviderRenderState = "live" | "offline" | "checking";

/** Show up to 8 models; the rest stay behind an aria-expanded "+N more". */
const MAX_VISIBLE_MODELS = 8;

function ModelChips({ models }: { models: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const overflow = models.length - MAX_VISIBLE_MODELS;
  const visible = expanded || overflow <= 0 ? models : models.slice(0, MAX_VISIBLE_MODELS);

  return (
    <span className="flex flex-wrap items-center gap-1">
      {visible.map((model) => (
        <span
          key={model}
          className="rounded-pill border border-line bg-canvas px-2 py-0.5 font-mono text-[11px] text-ink-2"
        >
          {model}
        </span>
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="rounded-pill border border-line px-2 py-0.5 text-[11px] text-ink-3 transition-colors duration-150 hover:bg-wash hover:text-ink"
        >
          {expanded ? "Show less" : `+${overflow} more`}
        </button>
      ) : null}
    </span>
  );
}

/**
 * One provider card: status dot + label (+ "· default"), status pill and the
 * endpoint / models / status rows (legacy liveProviderCards shape).
 */
export function ProviderCard({
  provider,
  state,
}: {
  provider: ProviderCardData;
  state: ProviderRenderState;
}) {
  const connected = state === "live" && provider.configured;
  const pill: { tone: BadgeTone; text: string } =
    state === "offline"
      ? { tone: "miss", text: "Unknown (offline)" }
      : state === "checking"
        ? { tone: "neutral", text: "Checking…" }
        : provider.configured
          ? { tone: "hit", text: "Connected" }
          : { tone: "neutral", text: "Not configured" };
  const statusNote =
    state === "offline"
      ? "unknown (offline)"
      : state === "checking"
        ? "waiting for /providers"
        : provider.configured
          ? "Connected"
          : "Not configured";

  return (
    <Card className="h-full">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "mt-[6px] size-2 shrink-0 rounded-full",
            connected ? "bg-ok" : "bg-ink-3",
          )}
        />
        <h3 className="min-w-0 text-[14px] font-medium text-ink">
          {provider.label}
          {provider.active ? (
            <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-3">· default</span>
          ) : null}
        </h3>
        <span className="ml-auto shrink-0">
          <Badge tone={pill.tone}>{pill.text}</Badge>
        </span>
      </div>

      <dl className="mt-3 space-y-2 text-[12px]">
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-ink-3">endpoint</dt>
          <dd className="min-w-0 break-all font-mono text-ink-2">{provider.endpoint || "—"}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-ink-3">models</dt>
          <dd className="min-w-0">
            <ModelChips models={provider.models ?? []} />
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-ink-3">status</dt>
          <dd className="min-w-0 text-ink-2">{statusNote}</dd>
        </div>
        {provider.active ? (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-ink-3">default</dt>
            <dd className="min-w-0 text-ink-2">active default provider</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

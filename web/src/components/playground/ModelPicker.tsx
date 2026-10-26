"use client";

/**
 * Model picker — the simple composer's one routing control.
 *
 * The gateway routes by model id alone (gpt-* → openai, claude-* → anthropic,
 * gemini-* → gemini, llama-* or nomic-* → ollama, `:free` → openrouter, else
 * the default provider), so a single model choice replaces the old
 * provider+model pair. The bundled catalog is a hint; "Refresh models" pulls
 * the LIVE $0 OpenRouter tier (public CORS-open endpoint, no key) and the
 * gateway's configured models from GET /providers, and a custom id can always
 * be typed. Nothing here blocks a request: the gateway stays authoritative.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui";
import { IconChevronDown, IconRefresh } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { GatewayClient } from "@/lib/gateway";
import { timeShort } from "@/lib/format";
import { useAppStore } from "@/lib/store";
import {
  catalogProviderId,
  isFreeModel,
  PROVIDER_ORDER,
  PROVIDERS,
  providerDisplayLabel,
  providerForModel,
} from "./catalog";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterModel {
  id?: string;
  pricing?: { prompt?: string; completion?: string };
}

/** Free tier = prompt AND completion price exactly "0" (the `:free` tier). */
async function fetchFreeOpenRouterModels(signal: AbortSignal): Promise<string[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`openrouter models: ${res.status}`);
  const json = (await res.json()) as { data?: OpenRouterModel[] };
  return (json.data ?? [])
    .filter(
      (m) =>
        typeof m.id === "string" &&
        m.id.endsWith(":free") &&
        m.pricing?.prompt === "0" &&
        m.pricing?.completion === "0",
    )
    .map((m) => m.id as string)
    .sort();
}

export function ModelPicker({
  model,
  onSelect,
}: {
  model: string;
  onSelect: (model: string) => void;
}) {
  const { connection, health } = useAppStore();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "free">("all");
  const [custom, setCustom] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [liveFree, setLiveFree] = useState<string[] | null>(null);
  const [liveConfigured, setLiveConfigured] = useState<string[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  // Outside click / Escape close — same contract as the connection menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const groups = useMemo(() => {
    const base: Record<string, string[]> = {};
    for (const id of PROVIDER_ORDER) base[id] = [...PROVIDERS[id].models];
    if (liveFree) {
      // Keep the curated (verified-working) ids first, then the rest of the
      // live $0 tier — free upstreams churn, so the first options stay usable.
      const curated = PROVIDERS.openrouter.models;
      base.openrouter = [...curated, ...liveFree.filter((id) => !curated.includes(id))];
    }
    if (liveConfigured) {
      for (const configured of liveConfigured) {
        const group = providerForModel(configured, "google");
        if (!base[group]) base[group] = [];
        if (!base[group].includes(configured)) base[group].push(configured);
      }
    }
    return PROVIDER_ORDER.map((id) => {
      const models = [...new Set(base[id])].filter((m) => filter === "all" || isFreeModel(m));
      return { id, label: PROVIDERS[id]?.label ?? id, models };
    }).filter((group) => group.models.length > 0);
  }, [filter, liveFree, liveConfigured]);

  const freeCount = useMemo(() => {
    const all = new Set<string>();
    for (const id of PROVIDER_ORDER) for (const m of PROVIDERS[id].models) all.add(m);
    for (const m of liveFree ?? []) all.add(m);
    for (const m of liveConfigured ?? []) all.add(m);
    return [...all].filter(isFreeModel).length;
  }, [liveFree, liveConfigured]);

  const pick = (next: string) => {
    onSelect(next);
    setOpen(false);
  };

  const refresh = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    const [free, configured] = await Promise.allSettled([
      fetchFreeOpenRouterModels(controller.signal),
      new GatewayClient(connection)
        .providers(controller.signal)
        .then((providers) => providers.flatMap((p) => p.models)),
    ]);
    if (controller.signal.aborted) return;
    if (free.status === "fulfilled") {
      setLiveFree(free.value);
      setRefreshFailed(false);
    }
    if (configured.status === "fulfilled") {
      setLiveConfigured(configured.value);
    }
    if (free.status === "rejected" && configured.status === "rejected") setRefreshFailed(true);
    setRefreshedAt(new Date().toISOString());
    setRefreshing(false);
  };

  const onCustomSubmit = (event: FormEvent) => {
    event.preventDefault();
    const next = custom.trim();
    if (next) pick(next);
  };

  const subLabel = providerDisplayLabel(
    providerForModel(model, catalogProviderId(health?.provider)),
  );

  const statusText = refreshing
    ? "Refreshing…"
    : refreshFailed
      ? "Refresh failed — bundled list"
      : refreshedAt
        ? `Updated ${timeShort(refreshedAt)}`
        : `${freeCount} free models bundled`;

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        id="pg-model"
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-9 w-full items-center gap-2 rounded-control border border-line bg-canvas px-2 text-left transition-colors duration-150 hover:bg-wash"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-ink">{model}</span>
          <span className="block truncate text-[10px] text-ink-3">
            {subLabel} · routes by model id
          </span>
        </span>
        {isFreeModel(model) ? (
          <span className="shrink-0 rounded-pill bg-ok-soft px-1.5 py-0.5 text-[10px] font-medium text-ok">
            $0
          </span>
        ) : null}
        <IconChevronDown
          size={14}
          className={cn("shrink-0 text-ink-3 transition-transform duration-150", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="mt-1 overflow-hidden rounded-card border border-line bg-canvas">
          <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1.5">
            <div className="flex items-center gap-1">
              {(["all", "free"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={filter === option}
                  onClick={() => setFilter(option)}
                  className={cn(
                    "rounded-pill px-2 py-0.5 text-[11px] transition-colors duration-150",
                    filter === option
                      ? "bg-active font-medium text-ink"
                      : "text-ink-2 hover:bg-wash hover:text-ink",
                  )}
                >
                  {option === "all" ? "All" : "$0 free"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Fetch the live $0 OpenRouter list and the gateway's configured models"
              className="flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] text-ink-2 transition-colors duration-150 hover:bg-wash hover:text-ink disabled:opacity-50"
            >
              <IconRefresh size={12} className={cn(refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>

          <div role="listbox" aria-label="Model" className="max-h-56 overflow-y-auto p-1">
            {groups.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-ink-3">
                No $0 models in the list — press Refresh for the live list.
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.id}>
                  <div className="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-ink-3 uppercase">
                    {group.label}
                  </div>
                  {group.models.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={option === model}
                      onClick={() => pick(option)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] transition-colors duration-150",
                        option === model
                          ? "bg-active font-medium text-ink"
                          : "text-ink-2 hover:bg-wash hover:text-ink",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{option}</span>
                      {isFreeModel(option) ? (
                        <span className="shrink-0 rounded-pill bg-ok-soft px-1.5 py-0.5 text-[10px] font-medium text-ok">
                          $0
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={onCustomSubmit}
            className="flex items-center gap-1.5 border-t border-line px-2 py-1.5"
          >
            <input
              type="text"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="Any model id…"
              aria-label="Custom model id"
              autoComplete="off"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-control border border-line bg-canvas px-2 font-mono text-[11px] text-ink placeholder:text-placeholder"
            />
            <Button type="submit" size="sm" disabled={!custom.trim()}>
              Use
            </Button>
          </form>
        </div>
      ) : null}

      <p aria-live="polite" className="mt-1 text-[11px] text-ink-3">
        {statusText} · {isFreeModel(model) ? "$0 tier — billed zero" : "billed by your provider"}
      </p>
    </div>
  );
}

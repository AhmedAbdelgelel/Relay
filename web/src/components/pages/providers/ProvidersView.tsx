"use client";

/**
 * Providers (inventory §2.5): live cards from GET /providers with an
 * offline-safe static catalog fallback (rough edge #15 — the fallback uses the
 * live provider ids, labels and endpoints), plus the routing explainer.
 *
 * The fetch is cancelled on unmount / connection change, and a failed poll
 * keeps the last successful list rather than clearing it.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Card, CardTitle } from "@/components/ui";
import { IconRefresh } from "@/components/ui/icons";
import { PageShell } from "@/components/pages/shared/PageShell";
import { GatewayClient } from "@/lib/gateway";
import { useAppStore } from "@/lib/store";
import type { ProviderStatus } from "@/lib/types";
import { AddProviderCard } from "./AddProviderCard";
import { PROVIDER_CATALOG } from "./catalog";
import { ProviderCard, type ProviderCardData, type ProviderRenderState } from "./ProviderCard";

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

export function ProvidersView() {
  const { connection, offline } = useAppStore();
  const [live, setLive] = useState<ProviderStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const client = new GatewayClient(connection);
    client
      .providers(controller.signal)
      .then((next) => {
        if (cancelled) return;
        setLive(Array.isArray(next) ? next : null);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connection, reload]);

  const refresh = useCallback(() => setReload((tick) => tick + 1), []);

  const unreachable = failed || offline;
  const entries: ProviderCardData[] =
    live ?? PROVIDER_CATALOG.map((entry) => ({ ...entry, configured: false, active: false }));
  const state: ProviderRenderState =
    live !== null ? "live" : unreachable ? "offline" : "checking";
  const activeId = live?.find((provider) => provider.active)?.id ?? null;
  const liveLine =
    live !== null
      ? `live · ${live.filter((provider) => provider.configured).length}/${live.length} configured${
          activeId ? ` · default ${activeId}` : ""
        }`
      : unreachable
        ? "offline · showing static catalog"
        : "checking /providers…";

  return (
    <PageShell
      title="Providers"
      sub="One integration per provider · canonical translation at the edge"
      actions={
        <span className="flex items-center gap-3">
          <span aria-live="polite" className="font-mono text-[12px] text-ink-3">
            {liveLine}
          </span>
          <Button size="sm" onClick={refresh} disabled={live === null && !unreachable}>
            <IconRefresh size={12} />
            Refresh
          </Button>
        </span>
      }
    >
      <Card className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
        <span className="text-[15px] font-medium text-ink">One unified interface</span>
        <span aria-hidden="true" className="text-ink-3">
          →
        </span>
        <span className="text-[15px] font-medium text-ink">Gateway · Router · Adapter</span>
        <span aria-hidden="true" className="text-ink-3">
          →
        </span>
        <span className="text-[15px] font-medium text-ink">OpenAI · Anthropic · Google</span>
      </Card>

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((provider) => (
          <li key={provider.id} data-provider={provider.id} className="min-w-0">
            <ProviderCard provider={provider} state={state} />
          </li>
        ))}
      </ul>

      <AddProviderCard live={live} onRegistered={refresh} />

      <Card>
        <CardTitle>How routing works</CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="text-[12px] font-medium text-ink">Model-prefix routing</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">
              <Mono>gpt-* → openai</Mono> · <Mono>claude-* → anthropic</Mono> ·{" "}
              <Mono>gemini-* → gemini</Mono>. <Mono>openrouter/…</Mono> and <Mono>:free</Mono>{" "}
              select OpenRouter; anything else falls back to the default provider.
            </p>
          </div>
          <div>
            <div className="text-[12px] font-medium text-ink">Canonical hashing</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">
              Requests are validated, canonicalized and hashed (<Mono>x-cache-hash</Mono>) before
              routing; responses are translated back to the OpenAI-compatible canonical shape.
            </p>
          </div>
          <div>
            <div className="text-[12px] font-medium text-ink">Server-side keys</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-2">
              API keys come from server env or a stored credential for a registered lane, never the
              browser.
            </p>
          </div>
        </div>
      </Card>
    </PageShell>
  );
}

"use client";

/**
 * Connect a provider (Providers page). Two modes, one card:
 *
 * - A registered gateway key is adopted (`connection.apiKey`): POST
 *   /v1/connections — attach your own upstream key and optional base URL for
 *   one provider on that gateway key. A provider card's Connect button
 *   remounts this card with `initialProvider` preselected.
 * - No gateway key yet: POST /v1/register — store the upstream key, issue a
 *   gateway key (shown exactly once) and adopt it. The register form also
 *   takes an optional upstream URL (stored as the credential's base_url) and
 *   the GATEWAY address (empty = same origin).
 *
 * Free tier: OpenRouter's `:free` models are billed $0 — pick one in the
 * Playground's model picker.
 */

import { useState, type FormEvent } from "react";
import { Button, Card, CardTitle } from "@/components/ui";
import { GatewayClient } from "@/lib/gateway";
import { useAppStore } from "@/lib/store";
import type { ConnectResult, ProviderStatus, RegisterResult } from "@/lib/types";
import { PROVIDER_CATALOG } from "./catalog";

const inputClasses =
  "h-8 w-full rounded-control border border-line bg-canvas px-2 text-[12px] text-ink placeholder:text-placeholder";

interface ProviderOption {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  configured: boolean;
}

function optionsFrom(live: ProviderStatus[] | null): ProviderOption[] {
  if (live !== null) return live;
  return PROVIDER_CATALOG.map((entry) => ({ ...entry, configured: false }));
}

export function AddProviderCard({
  live,
  onRegistered,
  initialProvider,
}: {
  live: ProviderStatus[] | null;
  onRegistered?: () => void;
  /** Preselected provider when the card is remounted from a card's Connect. */
  initialProvider?: string;
}) {
  const { connection, setConnection } = useAppStore();
  const options = optionsFrom(live);
  const hasGatewayKey = connection.apiKey !== "";

  const [provider, setProvider] = useState(initialProvider ?? "openrouter");
  const [name, setName] = useState("playground");
  const [providerKey, setProviderKey] = useState("");
  const [upstreamUrl, setUpstreamUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [connected, setConnected] = useState<ConnectResult | null>(null);

  const selected = options.find((option) => option.id === provider) ?? options[0];
  // The live list can arrive after mount: derive the effective id instead of
  // syncing state in an effect, so the picker and the submitted value agree.
  const effectiveProvider = options.some((option) => option.id === provider)
    ? provider
    : (options[0]?.id ?? provider);
  const freeCount = selected ? selected.models.filter((model) => model.endsWith(":free")).length : 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerKey.trim()) {
      setError("Paste the provider API key to register.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Register against exactly the entered gateway; the returned key is the
      // only secret this browser will ever hold.
      const client = new GatewayClient({ baseUrl: baseUrl.trim(), apiKey: "" });
      const issued = await client.register({
        name: name.trim() || "playground",
        provider: effectiveProvider,
        providerKey: providerKey.trim(),
        baseUrl: upstreamUrl.trim(),
      });
      setResult(issued);
      setProviderKey("");
      setUpstreamUrl("");
      onRegistered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onConnect = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerKey.trim()) {
      setError("Paste the provider API key to connect.");
      return;
    }
    setBusy(true);
    setError(null);
    setConnected(null);
    try {
      const client = new GatewayClient(connection);
      const result = await client.connectProvider({
        provider: effectiveProvider,
        providerKey: providerKey.trim(),
        baseUrl: upstreamUrl.trim(),
      });
      setConnected(result);
      setProviderKey("");
      setUpstreamUrl("");
      onRegistered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const useKey = () => {
    if (!result) return;
    setConnection({ baseUrl: baseUrl.trim(), apiKey: result.key });
    setResult(null);
    setConnected(null);
    onRegistered?.();
  };

  return (
    <Card>
      <CardTitle
        actions={
          <span className="text-[11px] text-ink-3">
            <span className="font-mono">
              {hasGatewayKey ? "POST /v1/connections" : "POST /v1/register"}
            </span>
          </span>
        }
      >
        {hasGatewayKey ? "Connect a provider" : "Add a provider"}
      </CardTitle>

      {result ? (
        <div className="space-y-3">
          <p className="text-[13px] text-ink">
            Registered with <span className="font-mono">{result.provider}</span> — tenant{" "}
            <span className="font-mono">{result.tenant_id.slice(0, 8)}…</span>
          </p>
          <div className="rounded-control border border-line bg-canvas px-3 py-2">
            <div className="text-[11px] text-ink-3">
              Gateway key — shown exactly once, stored nowhere in this browser until you use it
            </div>
            <div className="mt-1 font-mono text-[12px] break-all text-ink">{result.key}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={useKey}>
              Use this key
            </Button>
            <Button onClick={() => setResult(null)}>Register another</Button>
          </div>
        </div>
      ) : hasGatewayKey ? (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void onConnect(event)}>
          <div className="min-w-0">
            <label htmlFor="cp-provider" className="text-[11px] text-ink-3">
              Provider
            </label>
            <select
              id="cp-provider"
              value={effectiveProvider}
              onChange={(event) => setProvider(event.target.value)}
              className={inputClasses}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                  {option.configured ? " · server key" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="cp-upstream" className="text-[11px] text-ink-3">
              Upstream URL (optional)
            </label>
            <input
              id="cp-upstream"
              type="text"
              value={upstreamUrl}
              onChange={(event) => setUpstreamUrl(event.target.value)}
              placeholder={`gateway default (${selected?.endpoint ?? "—"})`}
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
          </div>
          <div className="min-w-0 sm:col-span-2">
            <label htmlFor="cp-key" className="text-[11px] text-ink-3">
              Provider API key
            </label>
            <input
              id="cp-key"
              type="password"
              value={providerKey}
              onChange={(event) => setProviderKey(event.target.value)}
              placeholder="stored encrypted on the gateway for this gateway key's tenant"
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
          </div>
          <div className="col-span-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-ink-3">
            <span className="min-w-0">
              Routing:{" "}
              <span className="font-mono break-all">
                {selected ? `${selected.models[0] ?? "*"} → ${effectiveProvider}` : "—"}
              </span>{" "}
              <span className="text-placeholder">(this gateway key only)</span>
            </span>
            {freeCount > 0 ? (
              <span className="shrink-0 text-ok">
                $0 tier · {freeCount} free models — pick one in the Playground
              </span>
            ) : null}
          </div>
          {connected ? (
            <p role="status" className="col-span-full text-[12px] text-ok">
              Connected <span className="font-mono">{connected.provider}</span> →{" "}
              <span className="font-mono break-all">{connected.endpoint}</span> — chats for this
              provider now use your key.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="col-span-full text-[12px] text-warn">
              {error}
            </p>
          ) : null}
          <div className="col-span-full flex items-center gap-2">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Connecting…" : "Connect provider"}
            </Button>
            <span className="text-[11px] text-ink-3">
              Replaces any existing key for this provider · shown nowhere after saving.
            </span>
          </div>
        </form>
      ) : (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void onSubmit(event)}>
          <div className="min-w-0">
            <label htmlFor="ap-provider" className="text-[11px] text-ink-3">
              Provider
            </label>
            <select
              id="ap-provider"
              value={effectiveProvider}
              onChange={(event) => setProvider(event.target.value)}
              className={inputClasses}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                  {option.configured ? " · server key" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="ap-name" className="text-[11px] text-ink-3">
              Workspace name
            </label>
            <input
              id="ap-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              className={inputClasses}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="ap-key" className="text-[11px] text-ink-3">
              Provider API key
            </label>
            <input
              id="ap-key"
              type="password"
              value={providerKey}
              onChange={(event) => setProviderKey(event.target.value)}
              placeholder="stored encrypted on the gateway"
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="ap-upstream" className="text-[11px] text-ink-3">
              Upstream URL (optional)
            </label>
            <input
              id="ap-upstream"
              type="text"
              value={upstreamUrl}
              onChange={(event) => setUpstreamUrl(event.target.value)}
              placeholder={`gateway default (${selected?.endpoint ?? "—"})`}
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="ap-base" className="text-[11px] text-ink-3">
              Gateway URL
            </label>
            <input
              id="ap-base"
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="same origin (leave empty)"
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
          </div>
          <div className="col-span-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-ink-3">
            <span className="min-w-0">
              Upstream:{" "}
              <span className="font-mono break-all">{selected?.endpoint ?? "—"}</span>{" "}
              <span className="text-placeholder">(gateway default — override with your own URL)</span>
            </span>
            {freeCount > 0 ? (
              <span className="shrink-0 text-ok">
                $0 tier · {freeCount} free models — pick one in the Playground
              </span>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="col-span-full text-[12px] text-warn">
              {error}
            </p>
          ) : null}
          <div className="col-span-full flex items-center gap-2">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Registering…" : "Register key"}
            </Button>
            <span className="text-[11px] text-ink-3">
              Issues a gateway key for the registered lane — caching and scoped usage included.
            </span>
          </div>
        </form>
      )}
    </Card>
  );
}

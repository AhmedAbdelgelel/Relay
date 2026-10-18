"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useAppStore } from "@/lib/store";
import { GatewayClient } from "@/lib/gateway";
import { Button } from "@/components/ui/Button";
import { IconChevronDown } from "@/components/ui/icons";
import type { RegisterResult } from "@/lib/types";

/** The product's provider list (gateway config enum) — register accepts any known one. */
const REGISTER_PROVIDERS = ["mock", "gemini", "ollama", "openai", "anthropic", "openrouter"] as const;

function avatarLetter(baseUrl: string): string {
  if (!baseUrl) return "D";
  try {
    const host = new URL(baseUrl).hostname;
    return (host.charAt(0) || "D").toUpperCase();
  } catch {
    return (baseUrl.charAt(0) || "D").toUpperCase();
  }
}

const inputClasses =
  "mb-3 mt-1 h-8 w-full rounded-control border border-line bg-canvas px-2 text-[12px] text-ink placeholder:text-placeholder";

/**
 * Sidebar footer: connection status + a small popover (anchored up) for the
 * gateway URL / API key. Persistence is owned by the store
 * (`llm-gateway-api-v1`), so there is exactly one writer.
 */
export function ConnectionMenu() {
  const { connection, setConnection, status, health, refresh } = useAppStore();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  // Register-in-place: the product's open route turns a try-out visitor into
  // a settled tenant without leaving the control plane.
  const [regName, setRegName] = useState("playground");
  const [regProvider, setRegProvider] = useState<string>("mock");
  const [regProviderKey, setRegProviderKey] = useState("");
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [regResult, setRegResult] = useState<RegisterResult | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openMenu = () => {
    // Seed drafts from the live connection each time the menu opens; a stale
    // register result/key from a previous session must not survive the reopen.
    setBaseUrl(connection.baseUrl);
    setApiKey(connection.apiKey);
    setRegProvider(health?.provider ?? "mock");
    setRegProviderKey("");
    setRegResult(null);
    setRegError(null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
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

  const apply = (apiKeyOverride?: string) => {
    setConnection({ baseUrl: baseUrl.trim(), apiKey: (apiKeyOverride ?? apiKey).trim() });
    refresh();
    setOpen(false);
  };

  const submitRegister = async (): Promise<void> => {
    setRegistering(true);
    setRegError(null);
    setRegResult(null);
    try {
      // Register against the DRAFTED base URL: works while configuring a
      // remote gateway before it is applied.
      const client = new GatewayClient({ baseUrl, apiKey: "" });
      const result = await client.register({
        name: regName.trim() || "playground",
        provider: regProvider,
        providerKey: regProviderKey.trim() || "unused",
      });
      setRegResult(result);
    } catch (error) {
      setRegError(error instanceof Error ? error.message : "Registration failed.");
    } finally {
      setRegistering(false);
    }
  };

  const statusText =
    status === "online"
      ? `Online · ${health?.provider ?? "gateway"}`
      : status === "error"
        ? "Error · gateway unreachable"
        : status === "offline"
          ? "Offline"
          : "Checking…";
  const dotClass = status === "online" ? "bg-ok" : status === "error" ? "bg-warn" : "bg-ink-3";

  return (
    <div ref={rootRef} className="relative mt-auto pt-2">
      {open ? (
        <div
          role="dialog"
          aria-label="Gateway connection"
          className="absolute inset-x-0 bottom-full z-40 mb-2 rounded-card border border-line bg-surface p-3 shadow-pop"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              apply();
            }}
          >
            <label htmlFor="conn-base" className="text-[11px] text-ink-3">
              Gateway URL
            </label>
            <input
              id="conn-base"
              ref={inputRef}
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="same origin (leave empty)"
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
            <label htmlFor="conn-key" className="text-[11px] text-ink-3">
              API key
            </label>
            <input
              id="conn-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="optional — Bearer lg_…"
              autoComplete="off"
              spellCheck={false}
              className={inputClasses}
            />
            <p className="mb-3 text-[11px] leading-4 text-ink-3">
              No key? Requests use the anonymous try-out lane — works out of the box, but always
              bypasses the cache. Paste a registered lg_… key to unlock caching.
            </p>
            <div className="flex items-center justify-between gap-2">
              <Button type="submit" variant="primary" size="sm">
                Apply
              </Button>
              <span className="text-[11px] text-ink-3">{statusText}</span>
            </div>
          </form>

          <details className="group rounded-card border border-line bg-canvas">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
              Register a gateway key
              <IconChevronDown
                size={12}
                className="shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-180"
              />
            </summary>
            <div className="border-t border-line px-2.5 py-2">
              <label htmlFor="reg-name" className="text-[11px] text-ink-3">
                Workspace name
              </label>
              <input
                id="reg-name"
                type="text"
                value={regName}
                onChange={(event) => setRegName(event.target.value)}
                placeholder="playground"
                autoComplete="off"
                spellCheck={false}
                className={inputClasses}
              />
              <label htmlFor="reg-provider" className="text-[11px] text-ink-3">
                Provider
              </label>
              <select
                id="reg-provider"
                value={regProvider}
                onChange={(event) => setRegProvider(event.target.value)}
                className={inputClasses}
              >
                {REGISTER_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <label htmlFor="reg-pkey" className="text-[11px] text-ink-3">
                Upstream provider key
              </label>
              <input
                id="reg-pkey"
                type="password"
                value={regProviderKey}
                onChange={(event) => setRegProviderKey(event.target.value)}
                placeholder={
                  regProvider === "mock"
                    ? "any string (mock ignores it)"
                    : regProvider === "openrouter"
                      ? "optional on :free models"
                      : "paste your real provider key"
                }
                autoComplete="off"
                spellCheck={false}
                className={inputClasses}
              />
              {regError ? (
                <p aria-live="polite" className="mb-2 text-[11px] leading-4 text-err">
                  {regError}
                </p>
              ) : null}
              {regResult ? (
                <div className="mb-2">
                  <p className="mb-1 text-[11px] leading-4 text-ink-2">
                    Key — shown once; registering again creates a new tenant.
                  </p>
                  <p className="mb-2 break-all font-mono text-[11px] leading-4 text-ink">
                    {regResult.key}
                  </p>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setApiKey(regResult.key);
                      apply(regResult.key);
                    }}
                  >
                    Use this key
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={registering}
                  onClick={() => void submitRegister()}
                >
                  {registering ? "Registering…" : "Register"}
                </Button>
              )}
            </div>
          </details>
        </div>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-150 hover:bg-wash"
      >
        <span className={cn("size-2 shrink-0 rounded-full", dotClass)} aria-hidden="true" />
        <span className="grid size-6 shrink-0 place-items-center rounded-[8px] border border-line bg-surface text-[11px] font-semibold text-ink-2">
          {avatarLetter(connection.baseUrl)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">dev-workspace</span>
          <span className="block truncate text-[11px] text-ink-3">
            {connection.baseUrl || "same origin"}
          </span>
        </span>
        <IconChevronDown size={14} className="shrink-0 text-ink-3" />
      </button>
    </div>
  );
}

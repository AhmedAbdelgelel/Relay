"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";
import { IconChevronDown } from "@/components/ui/icons";

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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openMenu = () => {
    // Seed drafts from the live connection each time the menu opens.
    setBaseUrl(connection.baseUrl);
    setApiKey(connection.apiKey);
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

  const apply = () => {
    setConnection({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
    refresh();
    setOpen(false);
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

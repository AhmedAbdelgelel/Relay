"use client";

/**
 * Compact inline gateway connection (URL + API key). Bound to the SAME store
 * connection the sidebar menu edits — lib/store owns persistence, so there is
 * no second copy in storage.
 *
 * Local drafts commit on blur / Enter. The parent re-keys this component when
 * the store connection changes externally (e.g. the sidebar menu applies a new
 * URL), which reseeds the drafts — that is the "two-way" sync.
 */

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useAppStore } from "@/lib/store";

const inputClasses =
  "h-8 w-full rounded-control border border-line bg-canvas px-2 text-[12px] text-ink placeholder:text-placeholder";

export function ConnectionFields() {
  const { connection, setConnection } = useAppStore();
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [apiKey, setApiKey] = useState(connection.apiKey);

  const commit = () => {
    const next = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() };
    if (next.baseUrl !== connection.baseUrl || next.apiKey !== connection.apiKey) {
      setConnection(next);
    }
    setBaseUrl(next.baseUrl);
    setApiKey(next.apiKey);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="min-w-0">
        <label htmlFor="pg-api-base" className="text-[11px] text-ink-3">
          Gateway URL
        </label>
        <input
          id="pg-api-base"
          type="text"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          placeholder="same origin (leave empty)"
          autoComplete="off"
          spellCheck={false}
          className={inputClasses}
        />
      </div>
      <div className="min-w-0">
        <label htmlFor="pg-api-key" className="text-[11px] text-ink-3">
          API key
        </label>
        <input
          id="pg-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          placeholder="optional — Bearer lg_…"
          autoComplete="off"
          spellCheck={false}
          className={inputClasses}
        />
      </div>
      <p className="col-span-2 text-[11px] leading-4 text-ink-3">
        No key? Requests use the anonymous try-out lane — works out of the box, but always
        bypasses the cache. Paste a registered lg_… key to unlock caching.
      </p>
    </div>
  );
}

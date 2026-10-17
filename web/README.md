# Relay Control Plane — `web/`

Next.js UI for the Relay LLM gateway: playground, live metrics, cache evidence,
request inspector, and provider status — built with **Next.js 16 (App Router)**,
**React 19**, **TypeScript**, and **Tailwind CSS v4**.

Design language follows the DeepSeek-style system extracted in
[`../agent/ui-nextjs.md`](../agent/ui-nextjs.md): soft canvas, white surfaces with
hairline borders, black pill primary buttons, one blue accent, system font stack
(no webfonts), light + dark themes with a pre-paint script (no flash).

## Quickstart

The gateway must be running first (repo root: `npm run dev` → `http://localhost:3000`).

```bash
cd web
npm install
npm run dev          # http://localhost:3001
```

All gateway traffic goes through a **same-origin proxy**: `/health`, `/metrics`,
`/providers` (JSON), and `/v1/*` are rewritten to `GATEWAY_URL`
(`next.config.ts`, default `http://localhost:3000`; see `.env.example`). No CORS
setup needed, no keys in the client bundle.

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` / `start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `test:watch` | Vitest + Testing Library suite |

## Architecture

```
src/app/            routes: / (overview), /playground, /requests, /cache, /providers
src/components/
  shell/            sidebar, topbar, connection menu (gateway URL + API key)
  ui/               Card, StatCard, Badge, Button, Table, EmptyState, Kbd, icons
  playground/       request panel, thread, metrics card, trace, session panel
  pages/            requests inspector, cache control room, providers status
src/lib/
  gateway.ts        typed browser client (chat + SSE streaming + evidence headers)
  canonical.ts      payload builder + canonical JSON + sha256 (byte-parity tested
                    against the gateway's real src/domain/normalize.ts)
  store.tsx         app state: chats, session stats, connection, 30 s health/metrics poll
  types.ts          gateway contract types
src/test/           vitest setup + fetch/SSE stub helpers
```

Honesty invariants carried over from the gateway: cache evidence
(`x-cache`, `x-cache-hash`, lanes, similarity) is always shown, estimated tokens are
marked `≈`, and the browser re-computes the canonical sha256 to verify what the
gateway reports.

## Testing

```bash
npm test             # 69 tests — canonical parity, SSE parsing, stats, components
```

The suite is hermetic (no network, no real timers). Contract tests lock the exact
cache-evidence copy so regressions surface as failing tests.

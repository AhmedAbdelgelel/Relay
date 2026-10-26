# Relay Control Plane — `web/`

Next.js UI for the Relay LLM gateway: playground, live metrics, cache evidence,
request inspector, provider status, settings (connection + advanced inspection) and
the registered lane's per-tenant usage — built with **Next.js 16 (App Router)**,
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

**Handoff link (demo):** append the connection as a URL fragment — e.g.
`http://localhost:3001/playground#apiKey=lg_…` (optional `&baseUrl=http://host:3000`).
Fragments are never sent to the gateway (not in requests, referrers or access logs);
the app consumes the fragment on hydration, persists the connection like a manually
entered one, and rewrites the URL so a refresh doesn't keep the key on screen.

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` / `start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm test` / `test:watch` | Vitest + Testing Library suite |

## Architecture

```
src/app/            routes: / (overview), /playground, /requests, /cache, /providers,
                    /settings
src/components/
  shell/            sidebar, topbar, connection menu (gateway URL + API key +
                    register-in-place via POST /v1/register)
  ui/               Card, StatCard, Badge, Button, Table, EmptyState, Kbd, Switch, icons
  playground/       model picker (free-tier filter + live refresh), request panel,
                    thread, metrics card, trace, session panel
  pages/            requests inspector, cache control room, providers (connect a
                    provider — BYO key + URL via POST /v1/connections — and add-provider
                    register flow), settings (advanced toggle + last-exchange inspector)
src/lib/
  gateway.ts        typed browser client (chat + SSE streaming + evidence headers
                    + GET /v1/usage tenant slice + GET/POST /v1/connections)
  canonical.ts      payload builder + canonical JSON + sha256 (byte-parity tested
                    against the gateway's real src/domain/normalize.ts)
  store.tsx         app state: chats, session stats, connection, advanced flag,
                    30 s health/metrics poll
  types.ts          gateway contract types
src/test/           vitest setup + fetch/SSE stub helpers
```

Honesty invariants carried over from the gateway: every completed reply shows its
cache verdict plus the plain-language hint (anonymous-lane BYPASS and semantic
similarity included). The full evidence (`x-cache`, `x-cache-hash`, lane/key id,
coalescing, fallback, canonical JSON), the request trace and the session counters
live behind Settings → Advanced. Estimated tokens are marked `≈`, and the browser
re-computes the canonical sha256 to verify what the gateway reports.

**Free-model demos.** The playground defaults to **non-streaming** requests: SSE
streams bypass both cache layers by design, while a non-stream request gets the
exact + semantic layers and shows the verdict badge/hint on every reply. The
bundled `$0` OpenRouter list only carries ids verified against the live free tier
(Free ids churn upstream; "Refresh" pulls the live public $0 list, curated ids
stay first, and a custom id can always be typed). When a free model's upstream is
retired or rate-limited, the error card says so and points at verified `$0` ids
with a Retry action instead of surfacing only the raw provider snippet.

## Testing

```bash
npm test             # 112 tests — canonical parity, SSE parsing, stats, components
```

The suite is hermetic (no network, no real timers). Contract tests lock the exact
cache-evidence copy so regressions surface as failing tests.

While a request is in flight the thread shows an animated **Thinking…** row (three
staggered dots, `role="status"`); the first SSE delta switches it to an animated
**Generating…** row with the partial text, and Advanced appends chunk / elapsed /
≈token stats. Both respect `prefers-reduced-motion`.

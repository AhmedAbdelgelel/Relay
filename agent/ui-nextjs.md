# Relay UI — Next.js Control Plane (redesign plan)

Status: **complete** · Owner: frontend · Reference design: **DeepSeek Harness (dsh) web UI**

## Goal

Reimplement the gateway's browser UI as a standalone **Next.js (App Router) + TypeScript**
application with full feature parity for every existing route (Overview, Playground,
Requests, Cache, Providers), styled after the dsh web UI, and delivered in small,
reviewable commits (each pushed).

The existing Fastify-served playground (`public/`, legacy JS) stays untouched and keeps
its tests green while the new app is built in `web/`.

## Architecture

- `web/` — standalone Next.js app (own `package.json`; the root package/CI is untouched).
- Data access: Next rewrites proxy same-origin `/v1/*`, `/health`, `/metrics`,
  `/providers` to the gateway (`GATEWAY_URL`, default `http://localhost:3000`) — no CORS
  changes, no API keys in the client bundle.
- Rendering: React Server Components for read-only surfaces (Overview, Providers,
  Cache snapshot); small client islands only where interactivity demands it
  (Playground streaming chat, live metrics polling, theme toggle).
- Styling: Tailwind CSS + CSS variables as design tokens. Light theme default (matches
  dsh), polished dark theme, persisted with a pre-paint script (no flash).
- Zero heavy UI dependencies: hand-rolled SVG icons/sparklines, native
  `fetch` + `ReadableStream` SSE parsing, no component or chart libraries.
- Fonts: system UI stack (exactly what dsh ships) — zero webfont payload.

## dsh design language (extracted from the shipped app)

Evidence: DeepSeek Harness settings screen + official harness site computed styles.

| Token | Value |
| --- | --- |
| Canvas (dark) | `#0a0a0a` |
| Canvas (light) | `#f5f5f6` family |
| Card / surface | white (light) · `#141414` family (dark) |
| Translucent surface | `rgba(255,255,255,.08)` on dark |
| Hairline ring | `0 0 0 .5px rgba(255,255,255,.08) inset` (dark) |
| Radius | 10px controls · 12–16px cards · 999px pills |
| Font | system UI stack, 12–14px chrome, medium weights |
| Primary action | black pill, white text (light) / white pill, black text (dark) |
| Accent | DeepSeek blue `#4d6bfe` — logos, focus rings only |
| Motion | short fades/translate (120–200ms), reduced-motion aware |

Layout language: narrow sidebar (brand + primary actions + list + bottom settings row),
lightweight topbar (breadcrumb + actions), content as stacked cards on canvas, settings
as a centered modal with its own left nav.

### Authoritative tokens (extracted from DeepSeek's shipped `--ds-*` variables)

```css
/* brand + text */
--brand: #4d6bfe;                 --brand-deep: #3a65c2;
--text-primary: #1e232c;         --text-secondary: rgba(0,0,0,.7);
--text-description: rgba(0,0,0,.65); --text-placeholder: #8691a1;
/* surfaces (light) — glass language */
--canvas: #f9f8f8;
--surface-1: hsla(0,0%,100%,.3);  --surface-2: hsla(0,0%,100%,.2);
--surface-3: rgba(0,0,0,.03);     --surface-raised: hsla(0,0%,100%,.45);
--overlay: #fff;
/* borders */
--border-subtle: rgba(0,0,0,.06); --border-default: rgba(0,0,0,.1);
--border-divider: rgba(0,0,0,.08);--border-strong: rgba(0,0,0,.2);
/* buttons */
--btn-primary-bg: #1a1615;       --btn-primary-text: #fff;
--btn-secondary-bg: hsla(0,0%,100%,.4); --btn-secondary-text: #1e232c;
--btn-ghost-hover-bg: rgba(0,0,0,.04);
/* radii */
--radius-input: 10px; --radius-sm: 8px; --radius-media: 12px;
--radius-panel: 16px; --radius-card: 24px; --radius-pill: 100px;
/* fonts */
--font-body: system-ui stack (the dsh app chrome uses -apple-system / Segoe UI;
             NO webfont in the app — keep it that way for performance)
```

Dark theme (from the dsh dark hero): canvas `#0a0a0a`, surfaces
`rgba(255,255,255,.04–.08)`, hairline `0 0 0 .5px rgba(255,255,255,.08) inset`,
text `#e7e9ec` / `rgba(255,255,255,.6)`, primary button inverted (white bg, black text).

## Delivered (every commit pushed to `origin/main`)

1. `91563f1` — `docs(plan)`: this document.
2. `af001cf` + `8b48a5e` — scaffold (Next.js 16.4.2, same-origin proxy rewrites) + design
   system, app shell, Overview.
3. `e9b9fcb` — playground: streaming chat, cache-evidence card, session stats.
4. `3e35a8d` — requests inspector, cache control room, providers status.
5. `8a6c1ac` — vitest + Testing Library suite: canonical sha256 parity against the gateway's
   real `src/domain/normalize.ts`, SSE parser, stats classification, component contracts.
6. `41417cb` + `547a7b0` — QA rounds 1+2: trace completion after a run, IME-safe Enter,
   New chat routing, anonymous try-out lane for zero-setup sends, stale-strip reset,
   mobile nav drawer, bare-seconds wait parser.
7. `29ccd5b` + `b62f449` — build hygiene: Turbopack root pinned to `web/`, unused import dropped.
8. `24d651a` — control-plane UI in the root README; plan marked complete with verification results.
9. `2764d13` — reply evidence persists on the chat message, so the lane/key/coalescing rows of
   the evidence card survive a reload (regression test included).
10. `b5e17f9` — full mobile-drawer contract test in jsdom (aria/scrim/scroll-lock/Escape/backdrop/
    route-change/breakpoint-crossing); `c59620f` — WCAG AA ink tokens (`ink-2` 0.65, `ink-3` 0.56/0.5);
    Lighthouse accessibility now 100/100 on Overview in light AND dark.
11. "Your usage" card on Overview — the registered lane's `GET /v1/usage` tenant slice (requests,
    exact/semantic hits, misses, derived hit rate, avoided calls, avg latency, coalesced) with
    honest anonymous/unavailable states; session panel discloses the latency sample size `(n=…)`
    once errors drop samples from the average.
12. Register-in-place — the connection menu's "Register a gateway key" disclosure drives the
    open `POST /v1/register` route (name/provider/upstream key drafted against the live menu;
    the issued key is shown once, and "Use this key" applies it immediately — an applied-key
    stale-draft race found in live verification is locked by a component contract test).
    Anonymous users now finish the product's zero-setup story without copy-pasting keys.
13. Simple composer + Advanced split — the playground shed its provider selector and sampling
    controls: the model is the one routing control (a picker with `All` / `$0 free` filters, a
    custom-id field, and `Refresh` that pulls the live CORS-open OpenRouter $0 tier plus the
    gateway's configured models from `GET /providers`). A new `/settings` route owns the
    connection editor and the persisted "Advanced" toggle: off, the playground is only the chat
    (no metrics line, evidence card, trace or session counters); on, every technical surface
    returns. Providers gains "Add a provider" (provider · upstream key · gateway URL →
    `POST /v1/register` → issued key shown once → "Use this key") plus a refresh action.
    Sampling stays gateway-side (`temperature ?? 1.0`), so the cache identity is byte-identical
    without the UI fields — pinned by the canonical parity test.
14. Connect a provider — the client half of the gateway's per-tenant connections round
    (`feat(gateway): per-tenant provider connections (BYO key + base_url) …`). With an adopted
    gateway key the provider card becomes "Connect a provider" (`POST /v1/connections`:
    provider · your upstream key · optional upstream URL), and every provider card grows a
    "your key" row — the tenant's stored endpoint + `connected` badge, or a `Connect` button
    that preselects that provider in the form (remount by key). `POST /v1/register` gained the
    same optional upstream URL, so a key minted from the UI already pins its own endpoint.
    `GET /v1/connections` is fetched alongside `/providers` on the registered lane and renders
    metadata only (provider · base URL · endpoint · created_at) — never key material. The
    mismatch 403 now carries its fix: "connect '<provider>' with your own key".

## Verification (results)

- `web/`: `npm run lint`, `npm run typecheck`, `npm run test` (101 passing across 14 files),
  `npm run build` (every route prerendered, incl. the new `/settings`) — green on the delivered tree.
- Lighthouse (harness browser): accessibility 100 · best-practices 100 · SEO 100 on `/` in both
  themes; the same bar passed on `/playground` in light before the usage panel landed.
- Live browser pass over all five routes: try-out lane send with no key (BYPASS + hint copy),
  registered key MISS → HIT with the `llm:exact:v1:mock:…` key and the "browser sha256 matches
  x-cache-hash" chip, cache page numbers equal `/metrics` (33.33% = 3 hit / 6 miss), providers
  line equals the raw `/providers` payload (3/6 configured, mock active default), theme flip
  instant + persisted across reload, error rows carry request id + status.
- Live pass for the simple-composer round: `/settings` renders the live cache config and the
  persisted Advanced toggle (SSR-safe — off in the HTML, hydrated from storage); the picker's
  `Refresh` pulled 19 live `$0` OpenRouter models (24 → 28 options) and the `$0 free` filter hid
  every paid id; a gateway key was minted end-to-end from "Add a provider" (shown-once key →
  "Use this key"), after which the playground showed the streamed BYPASS, a non-streamed
  MISS (109 ms) → HIT (24 ms) round trip, and the Settings "Last exchange" inspector
  (payload · canonical form · response) over one client session.
- Live pass for the provider-connections round (gateway restarted on the new code): OpenRouter
  was registered from the UI against the operator's env key, then a `:free` chat streamed a real
  completion (`provider=openrouter`, TTFT ≈ 2.1 s, usage reported). A differently-bound gateway
  key reproduced the reported 403 — now with the actionable "connect '<provider>' with your own
  key" hint — the card's `Connect` button preselected the provider, and after
  `POST /v1/connections` (tenant key + tenant URL → local stub upstream) the same chat served
  from the tenant endpoint in both JSON mode (MISS → 200) and stream mode. The OpenRouter and
  Ollama cards showed their "your key" rows; the rest stayed "not connected · Connect".
- QA findings and their fixes are tracked in the two `fix(web)` commits above. The mobile
  drawer at ≤767px is verified via jsdom behavior tests + generated-CSS inspection + a live
  synthetic-Escape check (the harness cannot size a viewport or screenshot, so pixel review
  remains manual).
- The legacy UI (`public/`) and its root test contracts are untouched.

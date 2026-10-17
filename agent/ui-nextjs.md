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

## Verification (results)

- `web/`: `npm run lint`, `npm run typecheck`, `npm run test` (70 passing), `npm run build`
  (all 9 routes prerendered) — green on the delivered tree.
- Live browser pass over all five routes: try-out lane send with no key (BYPASS + hint copy),
  registered key MISS → HIT with the `llm:exact:v1:mock:…` key and the "browser sha256 matches
  x-cache-hash" chip, cache page numbers equal `/metrics` (33.33% = 3 hit / 6 miss), providers
  line equals the raw `/providers` payload (3/6 configured, mock active default), theme flip
  instant + persisted across reload, error rows carry request id + status.
- QA findings and their fixes are tracked in the two `fix(web)` commits above. The mobile
  drawer at ≤767px is verified via jsdom behavior tests + generated-CSS inspection; the
  harness desktop could not emulate a narrow viewport, so pixel review remains manual.
- The legacy UI (`public/`) and its root test contracts are untouched.

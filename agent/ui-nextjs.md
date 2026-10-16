# Relay UI — Next.js Control Plane (redesign plan)

Status: **in progress** · Owner: frontend · Reference design: **DeepSeek Harness (dsh) web UI**

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

## Commit plan (each commit pushed to `origin/main`)

1. `docs(plan)` — this document.
2. `chore(web)` — scaffold Next.js app, proxy config, quality gates.
3. `feat(web): design system + app shell` — tokens, theme, sidebar, topbar, Overview page.
4. `feat(web): playground` — streaming chat, lanes, cache-evidence rendering, session stats.
5. `feat(web): requests + cache + providers pages`.
6. `test(web)` — unit/component tests for the new app.
7. `fix(web)` — issues found by the QA pass (browser, a11y, performance).
8. `docs` — README section for the new control plane.

## Verification

- `web/`: `npm run lint`, `npm run build`, component tests (vitest + Testing Library).
- QA pass with a dedicated subagent: live browser walk-through, console/network checks,
  Lighthouse, accessibility audit, then fixes.
- Root suite (`npm test`, `npm run typecheck`) must stay green — legacy UI untouched.

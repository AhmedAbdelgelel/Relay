# Relay legacy UI — feature inventory & frozen contract

Source of truth for reimplementing the control plane in `web/` (Next.js). Derived from an
exhaustive read of `public/` (index.html, styles.css, js/app.js, js/api.js, js/state.js,
js/config.js), `src/api/routes/*`, and the tests that pin the legacy UI.

> Legacy UI (`public/`) is **frozen**: keep it and its tests untouched and green.

## 1. Backend surface the UI uses

| Endpoint | Method | Caller | Response | Notes |
|---|---|---|---|---|
| `/health` | GET | `api.js:68` | `{ok, provider, cache, semantic, embedder, config:{cacheEnabled, cacheTtlSec, semanticEnabled, semanticThreshold, semanticTopK, semanticTtlSec, upstreamTimeoutMs}}` | Polled every 30 s + on config change / workspace switch / route mounts |
| `/metrics` | GET | `app.js:59` | metrics snapshot (see `src/observability/metrics.ts`): requests_total, exact_hits/misses, semantic_hits/misses/errors, singleflight_*, provider_requests/errors, cache_lookup_failed, cache_write_failed, fallback_count, breaker_open, tokens_in/out, estimated_cost_saved, semantic_hist_*, cache_lookups, cache_latency_ms_total, avg_cache_lookup_ms, provider_latency_ms_total, avg_provider_ms, hit_rate, provider_calls_avoided | Offline-safe: keep last snapshot on failure |
| `/providers` | GET | `app.js:1362` | `ProviderStatus[]`: `{id,label,endpoint,models[],configured,active}` | Static fallback card list when offline |
| `/v1/chat/completions` | POST | `api.js:74/87` | OpenAI shape; SSE when `stream:true` | Lane-gated; anonymous lane needs `x-provider-key` (try-out) |
| `/v1/register`, `/v1/usage` | POST/GET | **not used by UI** | — | Not CORS-enabled |
| `/`, `/styles.css`, `/js/:name` | GET | Browser | static assets | `/js/..%2F..%2F..%2F` → **403** (boundary pinned by tests) |

### CORS (pinned by `tests/integration/playground-send.test.ts`)
- allow-origin `*`; allow-headers `content-type, x-request-id, authorization, x-api-key, x-provider-key`; methods `GET, POST, OPTIONS`; `OPTIONS` → 204.
- expose-headers `x-request-id, x-provider, x-cache, x-cache-hash, x-latency-ms, x-coalesced, x-semantic-similarity, x-lane, x-key-id`.

### Evidence headers (produced by chat; some unused by legacy UI)
| Header | When | Value |
|---|---|---|
| `x-request-id` | every reply | echo or uuid |
| `x-lane` | every validated reply | `registered` \| `anonymous` |
| `x-key-id` | registered only | key record id |
| `x-cache-hash` | every validated request | sha256 of canonical JSON |
| `x-cache` | HIT / SEMANTIC_HIT / MISS / DISABLED / BYPASS (stream always BYPASS) | verdict |
| `x-semantic-similarity` | semantic hit | similarity .toFixed(4) |
| `x-provider` | HIT/SEMANTIC_HIT/MISS/stream base | serving adapter |
| `x-latency-ms` | non-stream: whole request; stream: **TTFT** | ms |
| `x-coalesced` | non-stream | true/false |
| `x-fallback` | fallback served | true |

### SSE framing
`data: {"id","model","choices":[{"delta":{"content":…}}]}` frames; optional terminal
`usage` frame; `data: [DONE]` terminator. Pre-first-token failure → real HTTP JSON error on
the hijacked socket with the same evidence headers; mid-stream failure closes the stream.

## 2. Routes

Router: hash-based (`#/overview`, `#/playground` (default + unknown fallback),
`#/requests`, `#/cache` (+ alias `#/semantic-cache`), `#/providers`). Removed hashes
(`#/agents`, `#/runs`, `#/evals`, `#/models`, `#/logs`, `#/settings`, `#/nonsense`) must
fall back to the playground. Frozen nav order: overview, playground, requests, cache, providers.

### 2.1 Overview
- 6 cards: Requests (+ provider calls), Success Rate, Avg Provider Latency, Tokens (session),
  Exact Hit Rate, Semantic Hit Rate. Session live strip: requests / tokens / `H HIT / S SEM / M MISS / B BYPASS` / errors.
- Cache lookup pipeline panel: `Request → Canonicalization → Exact Cache → Semantic Cache → Policy → Provider`.
- Gateway metrics table (17 rows: all counters + derived avgs).
- "Open Playground" primary action. Cold gateway = honest zeros — **never fabricate traffic**.

### 2.2 Playground
- Form: apiBase, apiKey (Bearer `lg_…`; plaintext in localStorage), provider select,
  model select (client-side catalog), temperature slider (label `#tempVal`), max tokens,
  streaming switch (default on), system textarea, composer (auto-grow, `≈ N tokens` hint),
  Send(↑/■ Stop) / Clear / Save Test (copies JSON payload; label flashes "Copied").
- Keyboard: Enter/Cmd/Ctrl+Enter send · Shift+Enter newline · Esc stop.
- Thread: greeting "Connected through your gateway…" + 3 suggestion chips; user rows;
  assistant rows with collapsible metrics line + metrics **card** (Cache badge+hint,
  cache key `llm:exact:v1:<provider>:<hash>` + copy, canonical preview + browser sha256
  verify (ok/bad/idle), latency (browser + gateway), TTFT (stream), tokens (≈ estimated
  when no usage), speed tok/s, stream chunks, provider·model, request id + time).
  Copy / Regenerate tools. Error rows (429 → Quota card with Retry), amber empty-response notices.
- Live metrics line while streaming: `streaming · N chunks · X.Xs · ≈T tok`.
- Response side: resp meta (latency/tokens/cost/cache + req id), Request Trace (8 steps),
  Session stats (16 cells; average latency must exclude… see rough edges).
- Session stats math: HIT ⇒ hits, reused += tokens; MISS ⇒ misses; DISABLED ⇒ disabled;
  BYPASS/other ⇒ bypassed; rate = round(hits/(hits+misses)); summary
  `"≈ N requests (B streamed) · R% HIT · T tokens [· E error(s)]"`.
- Honesty rules to preserve: browser↔gateway sha256 parity check, canonical preview
  (sorted keys, `stream` excluded), `stream:true` bypass messaging, ≈ markers.

### 2.3 Requests — "Request Inspector"
- Single last-request inspector (in-memory), 6 panels: Incoming Request, Canonical Request,
  Provider Request, Provider Response, Canonical Response, Final Response. Empty state:
  "No live request yet — send one from the Playground to inspect the real pipeline."

### 2.4 Cache
- 6 cards (Exact Hit Rate, Semantic Hit Rate, Provider Calls Avoided, Mean Similarity,
  Exact Lookup ms, Cache Errors) + two `details` panels (exact config JSON, semantic
  config JSON incl. threshold/top_k/ttl/hard filters/policy rejections) + footnote.

### 2.5 Providers
- Live cards from `/providers`: label + status pill (Connected / Not configured /
  Unknown) + dl (endpoint / models / status). Live line `live · N/M configured · default <id>`.
  Routing explainer panel. Offline → static catalog fallback.

### 2.6 Shell (all routes)
- Sidebar: brand (llm-gateway v0.1) + nav + `+ new chat` + chat stack (chat list, active,
  delete, title = first 42 chars) + workspace footer (`#statusDot`, avatar, name
  "dev-workspace", url, chevron; menu opens upward; Escape/outside closes).
- Topbar: breadcrumb `llm-gateway / <route>`, theme toggle (moon/sun).
- Persistence keys: `llm-gateway-theme`, `llm-gateway-api-v1`, `llm-gateway-workspaces-v1`,
  `llm-gateway-chats-v1` (max 30 chats).
- Mobile: `#menuBtn` toggles overlay (≤900 px) or collapsed sidebar (desktop).

## 3. Frozen legacy DOM contract (do not modify `public/`)

- `tests/unit/chat-ui.test.ts` (35): `#thread`, `.msg.user/.msg.assistant`, `.metrics`
  (role=button) + `.metrics-card` (hidden until click), `.badge.hit/.miss/.bypass`,
  `pre.canonical`, `.verify.ok/.bad`, `.mini-btn` Copy/"Regenerate", `.metrics.live`,
  `.content.streaming`, `#composerInput`/`#composerHint`/`#sendBtn`/`#sendLabel` (■),
  `#streamToggle[aria-checked]`, `#tempInput`/`#tempVal`, `#modelSel`, `#statsSummary`,
  `#statRequests/#statHits/#statMisses/#statRate/#statTokensIn/#statTokensOut/`
  `#statBypassed/#statReused/#statSaved/#statChunks/#statTtft`, `#chatStack .chat-item/.title/.chat-del`,
  `#newChatBtn`, `#menuBtn` → body.collapsed, `#statusDot.on`, `.provider-pill`.
- `tests/integration/ui-live.test.ts` (4): real server; seeded `llm-gateway-api-v1`;
  MISS→HIT with exact card texts (`"No entry for this key"`, `llm:exact:v1:mock:`,
  `.verify.ok "matches x-cache-hash"`, `.badge.hit` "provider was NOT called", reused +15,
  `#statSaved === #statHits`); stream BYPASS card texts; chat persistence across switch.
- `tests/integration/playground-send.test.ts` (4): boot via hash; send & card open;
  CORS preflight header sets; traversal 403.
- `tests/unit/control-plane-smoke.test.ts` (14): nav order; page copy contracts per route
  (e.g. Overview contains "42", must NOT contain "128,431"; Cache contains "SEMANTIC_HIT"
  and "0.92"); unknown hash falls back to playground.

## 4. Rough edges to fix in the redesign (code refs in legacy app)

1. `SEMANTIC_HIT` counted as bypassed (session stats); semantic cells permanently 0 / `—`.
2. `.badge semantic_hit` has no CSS; no hint/similarity shown for semantic hits.
3. Unused evidence: `x-lane`, `x-key-id`, `x-coalesced`, `x-semantic-similarity`, `x-fallback`.
4. Anonymous try-out lane unreachable (no `x-provider-key` path in UI).
5. Assistant `.who` uses form provider, not `x-provider`.
6. `#statSaved` ignores coalesced savings (server metric does not).
7. Avg latency divides by all requests incl. errors/aborts.
8. Mid-stream failure discards partial text (only `lastIO.text` keeps it).
9. Requests page mislabels placeholder panels.
10. Dead code/CSS across app.js/styles.css (topbar chips, reqCacheVerdict, dead pages CSS).
11. "Save Test" copies instead of saving; "Clear" thread-stays surprise.
12. Route switch loses composer draft & form tweaks (only apiConfig/chats/workspaces persist).
13. Static fallback ≠ full playground markup.
14. `custom` + hardcoded model catalog diverge from live `/providers`.
15. Providers fallback ids mismatch live ids.
16. Greeting hardcodes "Gemini".
17. Mean Similarity `--` when 0; token/cost/histogram metrics never surfaced.
18. Requests = single inspector under a plural nav label; no list/filters/clear/persistence.
19. `data-page` only on 2 routes.
20. Metrics line shows `X.Xs` even for 5 ms hits (no ms precision).
21. A11y: hardcoded `aria-expanded` on menu btn; no `aria-live`; metrics toggle lacks
    `aria-expanded/aria-controls`; workspace menu no arrow keys/focus mgmt; Stop button keeps
    "Send Request" accessible name; stale `meta theme-color`; no `prefers-color-scheme`.
22. Plaintext API keys in two localStorage keys.

The redesigned app should fix these where the new architecture makes it natural — without
breaking the legacy contract above (legacy stays as-is; fixes land in the new app).

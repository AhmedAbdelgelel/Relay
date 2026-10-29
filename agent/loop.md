# Loop — workflow, task record, runbook

Relay is an OpenAI-compatible LLM gateway (Fastify/TypeScript, exact + semantic
caching, pgvector/Redis, Next.js control plane, Docker/Compose, CI).
Product/architecture: `agent/implementation.md`. Testing: `agent/tests.md`.
Review: `agent/review.md`. This file is the live task record + runbook.

## Workflow

```
select pending task → read spec + constraints → implement smallest diff
→ tests (unit/contract/e2e per task) → typecheck → self-review
→ reviewer PASS → status completed → commit/push
```

Rules: one task per change; no architecture edits without approval; no invented
requirements; no test weakening; commit only when the suite + typecheck are green.
Task completion = implementation + acceptance tests + review PASS.

Statuses: `pending | in_progress | testing | review | blocked | completed | superseded`.
Live statuses are below.

## Tasks

Legend: **API** is the HTTP surface the task adds/changes. Internal tasks say
"none". Common request/response/error contracts are in `implementation.md` §5.

### T1 — HTTP contract, validation, error mapping — completed
**Goal:** reject bad input before spend; one error vocabulary.
**Files:** `src/api/routes/chat.ts`, `src/domain/types.ts`, `src/infrastructure/errors.ts`.
**API:** `POST /v1/chat/completions` — auth: registered `Bearer lg_…`/`x-api-key` or anonymous `x-provider-key`; body `{model, messages[], temperature?=1, max_tokens?, stream?=false, top_p?, stop?}` (strict schema: unknown fields → named 400; 512 KiB body cap); success `200` OpenAI shape + evidence headers; errors `400` invalid/unsupported field/capability, `401` no/bad key, `403` revoked/expired/provider mismatch, `429` upstream rate limit, `502` provider, `503` auth store, `504` timeout, `413` oversize.
**Acceptance:** invalid body → 400, provider/cache untouched; valid → provider response + `x-request-id`; errors never leak upstream internals.

### T2 — ProviderAdapter + factories — completed
**Goal:** one swappable adapter interface; adding a provider touches only the factory.
**Files:** `src/providers/*`.
**API:** none (internal). **Acceptance:** same canonical request → same shape from mock/OpenAI-compatible/Anthropic; prefix routing falls back to configured provider.

### T3 — Canonical key + `x-cache-hash` — completed
**Goal:** deterministic request identity; formatting noise must not split entries.
**Files:** `src/domain/normalize.ts`. **API:** header on every validated reply.
**Acceptance:** whitespace/key-order/default-temperature variants hash equal; model/prompt/temperature changes hash differently.

### T4 — Exact cache (memory/Redis) — completed
**Goal:** identical repeat is `$0`; bounded memory; Redis optional.
**Files:** `src/cache/CacheRepository.ts`, `InMemoryCache.ts`, `RedisCache.ts`, `factory.ts`.
**API:** none (serving path of chat). **Acceptance:** repeat → `x-cache: HIT`, provider avoided; corrupt entry evicted → MISS; cache outage → MISS, never 5xx.

### T5 — Single-flight — completed
**Goal:** N identical concurrent misses → 1 provider call.
**Files:** `src/cache/SingleFlight.ts` + chat wiring. **API:** none (headers `x-coalesced`).
**Acceptance:** 50 concurrent identical misses → 1 provider call, all 200; waiter abort does not kill shared work; failures do not poison the map.

### T6 — Streaming SSE — completed
**Goal:** first-token latency, abort semantics, terminal usage.
**Files:** `src/api/routes/chat.ts` (SSE), adapters' `chatStream`. **API:** `POST /v1/chat/completions` with `stream:true` → `text/event-stream` frames + terminal usage + `[DONE]`; pre-first-token failure = JSON error on socket; client disconnect aborts upstream.
**Acceptance:** SSE order/usage/`[DONE]`; pre-token error status; mid-stream close; failover only before first token.

### T7 — Metrics baseline — completed
**Goal:** operators see hits/misses/avoided calls without logs.
**Files:** `src/observability/metrics.ts`. **API:** `GET /metrics` counters/derived rates; `GET /health` wiring; `GET /providers` configured/active. **Acceptance:** HIT/MISS update metrics and `provider_calls_avoided`; no keys/prompts in responses.

### T8 — Provider conformance + capabilities — completed
**Goal:** adapters behave uniformly; unsupported features fail loudly.
**Files:** `src/providers/*`, `src/domain/types.ts`. **API:** `400 unsupported_capability` on chat before dispatch. **Acceptance:** capability matrix matches adapter behavior; provider never called on undeclared capability.

### T9 — Canonical response wiring — completed
**Goal:** one spelling per answer in cache; stream-safe normalization.
**Files:** `src/domain/responseNormalizer.ts` + chat wiring. **API:** none (stored content/stream deltas).
**Acceptance:** straddling markup never mis-emitted; admission uses normalized text; usage preserved-or-absent.

### T10 — Embeddings + vector store — completed
**Goal:** paraphrase recall behind a port; 768-d vectors.
**Files:** `src/embeddings/*`, `src/cache/InMemoryVectorStore.ts`, `PgVectorStore.ts`, `semanticFactory.ts`.
**API:** none. **Acceptance:** dim mismatch fails loud; store swap changes no lookup semantics; PG migration creates table/index; pgvector missing extension fails boot.

### T11 — Semantic lookup path — completed
**Goal:** safe paraphrases become $0 hits; exact-before-semantic.
**Files:** `src/api/routes/chat.ts` (non-stream branch). **API:** chat → `x-cache: SEMANTIC_HIT` + `x-semantic-similarity`; embed/store failure → MISS, never 5xx.
**Acceptance:** paraphrase reuses with similarity; unrelated prompt misses; outage still succeeds.

### T12 — Reuse policy hardening — completed
**Goal:** retrieval finds close; policy decides safe.
**Files:** `src/policy/reuse.ts`. **API:** none. **Acceptance:** every unsafe variant (`provider/tenant/model/temperature/max-tokens/system-fingerprint/policy-version/below-threshold/empty-content`) returns `reusable:false` with reason.

### T13 — Admission + eviction — completed
**Goal:** only safe/non-empty answers admitted; bounded memory.
**Files:** `src/cache/*`, admission in chat. **API:** none. **Acceptance:** empty/error responses never cached; TTL expiry; LRU caps (exact 1000 / semantic 2000); dedupe by prompt hash; write failure never fails request.

### T14 — Provider fallback + retries + breaker — completed
**Goal:** keep serving through transient provider failures.
**Files:** `src/routing/fallback.ts`, `src/api/routes/chat.ts`. **API:** chat `x-fallback:true` when failover serves; `502` when exhausted; `/metrics` gains `fallback_count`, `breaker_open`.
**Acceptance:** retry within target, then failover; breaker open/skip/probe; all-open 502; provider-specific model ids never cross vendors; fallback cached under serving provider key.

### T15 — Eval harness + cost metrics — completed
**Goal:** threshold decided by data; savings visible.
**Files:** `scripts/eval/*`, `evaluation/report.md`, `evaluation/real-embeddings-report.md`, `src/observability/metrics.ts`. **API:** `/metrics` adds similarity histogram, tokens, `estimated_cost_saved`; no new routes. **Acceptance:** controlled dataset sweep + real-embedding sweep (`npm run eval:real`), deterministic reports; production default 0.95 justified by real-embedding zero-FP boundary; controlled 0.92 optimum is policy-math only.

### T16 — Policy depth (tenant/fingerprint/version) — completed
**Goal:** reuse safety independent of store filters.
**Files:** `src/policy/reuse.ts`, semantic stores, migration mirror `db/migrations/004_semantic_system_fp.sql`. **API:** none. **Acceptance:** system-prompt change never reuses; older policy-version rows rejected; legacy NULL fingerprint skipped.

### T17 — Empty exact-cache admission fix — completed
**Goal:** no blank answer enters L1.
**Files:** `src/api/routes/chat.ts` admission. **API:** chat behavior only. **Acceptance:** empty provider reply served once, never stored; repeat → MISS.

### T18 — Live re-verification (semantic + TTL) — pending
**Goal:** prove semantic path + TTL against a real upstream after quota reset. **Files:** none (live run only). **API:** none. **Acceptance:** paraphrase SEMANTIC_HIT with similarity, temp/model/tenant drift MISS; TTL expiry MISS on both stores; evidence reported. Note: cache legs were re-run manually on 2026-10-26; original Gemini-embedder run remains.

### T19 — Push commits — completed
**Goal:** remote matches verified local tree. **API:** none.

### T20 — README + env template + license — completed
**Goal:** stranger can run it; every config documented; MIT license. **Files:** `README.md`, `.env.example`, `LICENSE`. **API:** none.

### T21 — Docker + CI — completed
**Goal:** reproducible gateway image + CI gate; publish image on main. **Files:** `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`. **API:** container exposes gateway routes on `PORT`; `/health` is the healthcheck.

### T22 — Auth posture (token mode) — superseded
History only; implementation tracked in T23–T27.

### T23 — Auth seed config + migration — completed
**Goal:** keys/credentials have a home; dev zero-setup; encrypted credentials.
**Files:** `src/infrastructure/config.ts`, `db/migrations/002_api_keys.sql` (reference).
**API:** none. **Acceptance:** seed `tenant:provider:name:key` parsing/fail-fast; `CRED_ENC_KEY` required with `DATABASE_URL`.

### T24 — Key/credential ports — completed
**Goal:** auth code depends on ports, not SQL.
**Files:** `src/auth/ApiKeyStore.ts`, `CredentialStore.ts`, memory/PG implementations.
**API:** none. **Acceptance:** verify/create/list/revoke/rotate; hash-only storage; encrypted credential round-trip; revoked/expired rejection.

### T25 — Lane guard — completed
**Goal:** one guard owns lane pick + auth error vocabulary, before validation/provider/cache.
**Files:** `src/auth/laneGuard.ts`. **API:** preHandler for chat/usage/connections — `401 missing_api_key|invalid_api_key` (register hint), `403 key_revoked|key_expired|provider_mismatch`, `503 auth_unavailable`.
**Acceptance:** full lane matrix; no spend on auth failure; no key material in logs.

### T26 — Chat with two lanes — completed
**Goal:** registered lane = cache + accounting; anonymous = BYPASS, header key only.
**Files:** `src/api/routes/chat.ts`, `src/server.ts`. **API:** `POST /v1/chat/completions` — reply `x-lane: registered|anonymous`; registered adds `x-key-id`; anonymous always `x-cache: BYPASS`; `x-tenant-id` ignored.
**Acceptance:** registered exact/semantic hits + tenant usage; anonymous never touches cache/server keys; 401 before validation; provider binding enforced.

### T27 — Register + own usage — completed
**Goal:** one call turns try-out into settled user; tenant sees only its numbers.
**Files:** `src/api/routes/register.ts`, `src/api/routes/usage.ts`, metrics. **API:** `POST /v1/register` (open) → `201 {tenant_id,provider,key,key_prefix}` key shown once (`400` validation, `503` store); `GET /v1/usage` (registered) → caller tenant slice incl. hit rate/avoided calls/avg latency (`401`/`403`); `/metrics` adds `auth_rejects_total`.
**Acceptance:** register 201/key-once; usage tenant-isolated; 400/401/403/503 matrix; no secrets in bodies.

### T28 — Per-tenant provider connections — completed
**Goal:** BYO key + optional base URL for routed providers (OpenRouter free on keyless gateway).
**Files:** `src/api/routes/connections.ts`, `src/auth/PgAuthStores.ts` (+ migration 003), chat credential resolution. **API:** `POST /v1/connections` (registered) `{provider,provider_key,base_url?}` → `201 {provider,base_url,endpoint,connected}` (`400` validation, `401` anonymous, `403`, `503`); `GET /v1/connections` (registered) → `{tenant_id, connections[{provider,base_url,endpoint,created_at}]}` metadata only, `401`/`403`/`503`.
**Acceptance:** reconnect replaces key+URL; tenant isolation; mismatched key gets actionable 403; keyless gateway serves once connected; no key material returned.

### T29 — Next.js control plane — completed
**Goal:** simple caching-focused UI + full evidence on demand.
**Files:** `web/**`. **API consumed:** `GET /health`, `/metrics`, `/providers`, `/v1/usage`, `/v1/connections`; `POST /v1/chat/completions` (JSON + SSE), `/v1/register`, `/v1/connections`. No new gateway routes; same-origin proxy via `GATEWAY_URL`.
**Acceptance:** correct cache verdicts/evidence, per-tenant usage, provider connections; 112 UI tests, lint/typecheck/build green; simple mode shows one cache verdict/hint, Advanced shows full evidence/trace/session.

### T30 — Docker Compose + benchmark harness — completed
**Goal:** whole stack in Docker; reproducible performance numbers.
**Files:** `docker-compose.yml`, `scripts/bench/cache.ts`, `package.json` (`npm run bench`). **API:** none (compose exposes gateway `:3000`, web `:3001`; benchmark drives the real app locally).
**Acceptance:** `docker compose up --build` starts gateway+web+Redis; `npm run bench` prints table + `BENCH_JSON` (44/44 assertions) with no external network; README numbers reproducible.

### Hardening pass (2026-10-29) — completed

**T31 — tenant-scoped exact cache.** Key `llm:exact:v2:<tenant>:<provider>:<hash>` from verified auth; fallback lookups/writes use same tenant. **API:** chat only; `x-cache-hash` unchanged. Tests: `tests/e2e/tenant-cache-isolation.e2e.test.ts` (A MISS, B MISS, B HIT, same-tenant HIT).

**T32 — explicit request schema.** Supported fields only (`model`, `messages`, `temperature`, `max_tokens`, `stream`, `top_p`, `stop`); `.strict()` → named 400 for unknown fields before spend; adapters forward supported fields (Anthropic `stop_sequences`). **API:** `POST /v1/chat/completions` `400 invalid_request`; tests `tests/e2e/request-schema.e2e.test.ts`.

**T33 — cache-identity audit.** Canonical identity includes model/messages/temperature/max_tokens/`top_p`/`stop`; equivalent requests share hash, different settings cannot collide. Semantic store cannot verify `top_p`/`stop`, so semantic lookup/admission is skipped for those requests; `POLICY_VERSION=2`. **API:** none.

**T34 — benchmark command verification.** `npm run bench` already existed; reproducible from clean checkout (44/44 checks, ~11.5 s). No defect; docs updated.

**T35 — repeatable perf benchmark.** `scripts/bench/perf.ts` / `npm run bench:perf`: 6 scenarios × 5 repeats × concurrency 1/10/50/100, 1,000 requests/scenario, warm-up, P50/P95/P99/throughput/errors/RSS/heap, environment, `BENCH_JSON`; mock-provider labeled. **API:** none.

**T36 — failure/stress tests.** `tests/e2e/resilience.e2e.test.ts` (17 tests): pgvector/Redis outages, timeout/refused, malformed JSON/SSE, 256 KB vs >1 MB bodies, aborts/cleanup, retry storms/breaker, stampede. **API:** none.

**T37 — real-embedding semantic eval.** `scripts/eval/realEmbeddings.ts` / `npm run eval:real`: 233 labelled pairs × 12 thresholds through real ONNX embedder + store + policy; zero-FP boundary 0.95, 4 FPs at 0.92; false-positive gallery + per-family metrics. **API:** none.

**T38 — economics/admission policy.** Report adds provider/embedding/storage/net-savings assumptions and explicit admission rules (non-empty normalized success only; no reuse below threshold; no semantic reuse with unverifiable sampling fields). **API:** none.

**T39 — README evidence/trade-offs.** Architecture + request flow, exact-before-semantic rationale, Redis/Postgres roles, API subset, test/bench methodology, measured vs design claims, known limits. **API:** documentation.

**T40 — production-readiness/SSRF/secrets.** SSRF-hardened `base_url` validation (private/loopback/link-local/metadata/reserved/DNS; `ALLOW_PRIVATE_PROVIDER_URLS` opt-in; redirects blocked); provider-error redaction; 512 KiB body cap; secret-redaction and auth coverage tests. **API:** `POST /v1/register`, `POST/GET /v1/connections` `400` for rejected `base_url`; tests `base-url-security` + `secret-redaction`.

## Runbook

```bash
npm install
npm run dev            # gateway http://localhost:3000 (mock provider)
npm run build && npm start
npm test               # hermetic: 29 files passed, 4 skipped; 371 passed, 11 skipped
npm run typecheck
npm run eval           # controlled-cosine threshold sweep -> evaluation/report.md
npm run eval:real      # real ONNX-embedding eval -> evaluation/real-embeddings-report.md
npm run bench          # cache-correctness benchmark (44/44 assertions)
npm run bench:perf     # repeatable perf benchmark (100k requests; --quick smoke)

cd web && npm install
npm run dev            # UI http://localhost:3001 (gateway must be running)
npm run typecheck && npm run lint && npm test && npm run build

docker compose up --build   # gateway :3000 + web :3001 + Redis
```

### Endpoints

`POST /v1/chat/completions` · `POST /v1/register` · `GET /v1/usage` ·
`POST|GET /v1/connections` · `GET /health` · `GET /metrics` · `GET /providers` ·
`GET /` (+ `/styles.css`, `/js/:name` legacy UI). Full contracts in
`implementation.md` §5.

### Env (all parsed in `src/infrastructure/config.ts`; defaults in `.env.example`)

Core: `PORT`, `PROVIDER` (`mock|gemini|ollama|openai|anthropic|openrouter`),
`UPSTREAM_TIMEOUT_MS`.
Caches: `CACHE_ENABLED`, `CACHE_TTL_S`, `REDIS_URL`; `SEMANTIC_ENABLED`,
`SEMANTIC_STORE` (`memory|pgvector`), `SEMANTIC_THRESHOLD`, `SEMANTIC_TOP_K`,
`SEMANTIC_TTL_S`, `EMBEDDING_PROVIDER` (`mock|gemini|ollama|local`),
`EMBEDDING_MODEL`.
Providers: `GEMINI_*`, `OPENAI_*`, `ANTHROPIC_*`, `OLLAMA_*`,
`OPEN_ROUTER_KEY`, `OPENROUTER_MODEL` (default `cohere/north-mini-code:free`),
`OPENROUTER_BASE_URL`.
Auth/storage: `GATEWAY_API_KEYS`, `CRED_ENC_KEY`, `DATABASE_URL`.
SSRF: `ALLOW_PRIVATE_PROVIDER_URLS` (default false; explicit opt-in for trusted
self-hosted provider URLs).
Reporting: `SAVED_USD_PER_1K_TOKENS`.

### Metrics keys

Counters: `requests_total`, `exact_hits`, `exact_misses`,
`singleflight_leaders`, `singleflight_coalesced`, `provider_requests`,
`provider_errors`, `cache_lookup_failed`, `cache_write_failed`, `semantic_hits`,
`semantic_misses`, `semantic_errors`, `fallback_count`, `breaker_open`,
`tokens_in`, `tokens_out`, `estimated_cost_saved`, `semantic_hist_*`,
`auth_rejects_total`.
Derived: `semantic_lookups`, `avg_semantic_score`, `cache_lookups`,
`avg_cache_lookup_ms`, `provider_latency_ms_total`, `avg_provider_ms`,
`hit_rate`, `provider_calls_avoided` (exact + coalesced; semantic reuse is
`semantic_hits`).

### Tests + live spend

`npm test` is hermetic (29 files passed / 4 skipped; 371 passed / 11 skipped);
live suites are opt-in: `OPENROUTER_LIVE_TEST=1` + `OPEN_ROUTER_KEY` (free `:free`
models, `npm run test:live`), `GEMINI_LIVE_TEST=1`, `EMBEDDING_LIVE_TEST=1`,
`REDIS_LIVE_TEST=1`. A key in `.env` alone never triggers live calls.

### Health triage

No lane → 401 no spend. Registered key provider must match serving provider
(unless tenant connected a credential) else 403. Anonymous uses header key only,
BYPASS, no accounting. Cache/Redis/pgvector down → MISS + failure counters, never
5xx. Provider errors → 429/502/504 per mapping. Config typos fail boot.
Provider-specific model ids retry/fail within their provider (no cross-vendor
failover). See `SECURITY.md` for the threat model and limits.

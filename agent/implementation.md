# Implementation Agent (main spec + discipline)

> The AI agent implements, tests, and iterates. It never redesigns the architecture.
> Discipline lives in Parts C–G below. Task list + end-to-end loop live in `agent/loop.md`.
> Testing detail lives in `agent/tests.md`. Review protocol lives in `agent/review.md`.

# First — the whole job in one page

## Goal

An OpenAI-compatible **LLM Gateway** between clients and LLM providers that cuts token
usage, latency, and cost via exact + semantic caching — without ever returning a wrong
answer.

## Problem

Repeated / paraphrased prompts waste money and latency, but naive caching is dangerous:
`Similarity != Equivalence != Reusability`. Reuse must be explicit, safe, and measurable —
decided by data, not feel.

## Tasks

Shipped: T1–T17, T20, T21, T23–T27 (contract, providers + capabilities, canonical key, exact cache,
single-flight, streaming, metrics, normalization, embeddings incl. built-in ONNX, semantic lookup,
reuse policy, admission, fallback + breaker, eval/cost metrics, policy depth, auth lanes, register,
usage, per-tenant provider connections, README/env/LICENSE, Docker + CI, push). Remaining open:
**T18** (live re-verification after quota reset; its cache legs were re-run manually on 2026-10-26
with two OpenRouter free models). Full definitions in `agent/loop.md` §Tasks. One task per pass.

## Arch

Two lanes on one chat endpoint, then one pipeline: lane pick → validate → canonicalize (sha256) → exact lookup → semantic lookup (policy
gate) → single-flight → provider → normalize → admit → reply. Full source of truth in
Part B below. Invariants: no lane → 401 with no spend; invalid → 400 with no spend; cache/embed failure → MISS never
5xx; N identical misses → 1 provider call; semantic HIT only if policy says reusable.

> Read this page, then Product (Part A), Architecture (Part B), and the ONE task
> (`agent/loop.md` §Tasks) — every time, every task.

---

# PART A — Product

## Core Features (shipped, test-verified)

1. **Client contract** — `POST /v1/chat/completions` (OpenAI subset), validation before
   spend, standardized errors, evidence headers.
2. **Provider layer** — one adapter interface with a per-adapter `capabilities`
   declaration (T8); mock (delay + failure injection), OpenAI-compatible
   (OpenAI/Gemini/Ollama/OpenRouter), Anthropic; per-model prefix routing.
3. **Exact cache ($0)** — canonical sha256 request identity → Redis or bounded
   in-memory LRU; single-flight coalescing; malformed-entry eviction.
4. **Semantic cache ($0 on safe paraphrases)** — 768-d embeddings (mock/gemini/ollama),
   in-memory brute-force or pgvector cosine search, tenant/provider/model isolation,
   pure reuse policy gate with reason codes.
5. **Streaming** — SSE framing, headers-on-first-token, client-abort propagation,
   terminal usage frame, bounded hold-back markup normalization, cache bypass.
6. **Observability** — `/metrics` JSON snapshot, `/health`, `/providers`, one-line JSON
   logs; playground UI.

## Functional Requirements

- FR-1 Valid request → provider response with `x-request-id`; invalid body →
  `400 {error:{code,message}}` before any provider call.
- FR-2 Provider timeout → `504`; provider 429/500 → `429/502`; upstream internals never leak.
- FR-3 `stream:true` → SSE; client disconnect aborts upstream; pre-first-token failures
  return real JSON errors.
- FR-4 Repeat identical request → `x-cache:HIT`, provider avoided; N concurrent identical
  misses → 1 provider call.
- FR-5 Paraphrase on seeded semantic entry → `x-cache:SEMANTIC_HIT` + similarity header;
  unrelated prompt → provider call.
- FR-6 Embedder/vector outage → MISS, request still succeeds; cross-tenant/model reuse
  impossible.
- FR-7 Usage preserved when reported, absent otherwise — never invented.

## Non-Goals (this cycle)

- Prometheus/tracing export; rate-limit/quotas; tenancy dashboards; multi-region.
- A scheduled pgvector purge job (rows expire logically; the table is not vacuumed by the gateway).
- Distributed single-flight/breaker if the gateway ever runs multi-instance.

## Constraints

- Single-process Node/Fastify service; modular monolith
  (api/domain/cache/embeddings/providers/policy/observability layers).
- Exact-before-semantic lookup order; non-streaming requests only may be served from cache.
- Embedding dimension fixed at 768 (text-embedding-004 / nomic-embed-text); changing it
  requires a migration.
- No new runtime dependency without a stated why; provider SDKs are not used (plain fetch).

## Future Considerations

- Provider prompt-cache discount exposure (`cached_tokens`) as a third savings layer.
- Prometheus export + latency histograms beyond the JSON snapshot.
- Priced tenants with quotas/dashboards.
- Distributed single-flight/breaker if the gateway ever runs multi-instance.

## Process directives

- Prefer test-backed decisions. A refactor that is merely code motion (same observable
  behavior, same tests) is acceptable.
- A documentation-only change is acceptable if statuses are kept true.
- **Never** invent behavior not covered by the Functional Requirements above. Extra ideas
  are proposals, not code drops.

---

# PART B — Architecture (source of truth for implementation)

> The AI agent must NOT silently modify this Part; conflicts are reported via
> ARCHITECTURE_CONFLICT (§4). Task history and the current open work (T18) are tracked in
> `agent/loop.md` §Tasks; T14/T15/T16/T24–T27 are shipped.

## System Overview

```text
Client -> POST /v1/chat/completions
  -> Lane pick (gateway key: registered | provider key: anonymous | neither: 401, no spend)
  -> Validate (400 never calls provider/cache)
  -> Canonicalize -> sha256 -> x-cache-hash
  -> Exact cache lookup (Redis | in-memory LRU)
      HIT -> 200 x-cache:HIT
  -> Semantic lookup (non-stream only):
      embed(role-tagged prompt) -> findSimilar(tenant,provider,model, topK)
      -> reuse policy gate -> HIT: 200 x-cache:SEMANTIC_HIT | SKIP: continue
  -> Single-flight (key = exact key; waiter abort never kills shared work)
  -> ProviderAdapter (mock | openai-compatible | anthropic)
      timeout + client-abort share one AbortController
  -> Response normalizer (strip presentation markup pre-admission)
  -> Admission: success + non-empty only; write exact + semantic (best-effort)
  -> stream:true bypasses caches; SSE framing; [DONE]; usage frame
  -> Every validated reply: x-request-id, x-provider, x-cache-hash, x-latency-ms
```

Built: key/credential ports + lane guard + chat lanes + register/usage/connections (T24–T27),
ordered fallback chain + breaker (T14), policy-level fingerprint/tenant/version re-checks (T16),
eval harness + cost metrics (T15). Open: T18 only (live re-verification).

## Components

### HTTP layer (`src/api/routes/chat.ts`)

- **Responsibility:** Validate, wire timeouts/aborts, orchestrate lookup order, frame SSE,
  map errors. HTTP only — no fetch, no provider SDK.
- **Inputs:** Raw Fastify request (JSON body, `x-request-id`, `x-tenant-id` headers),
  `GatewayConfig`, injected provider(s), `CacheRepository`, `SemanticCacheStore`,
  `EmbeddingProvider`, `SingleFlight`.
- **Outputs:** OpenAI-shaped reply or `{error:{code,message,request_id}}` with evidence
  headers (`x-request-id`, `x-provider`, `x-cache`, `x-cache-hash`, `x-latency-ms`,
  `x-semantic-similarity`, `x-coalesced`); metric increments; one JSON log line.
- **Dependencies:** domain (types, normalize, responseNormalizer), cache ports, embeddings
  port, policy (pure), providers factory, observability.
- **Interface:** `registerChatRoutes(app, provider, cfg, cache?, deps?)` — deps inject
  semantic store/embedder/providers map for tests.
- **Constraints:** 400 never touches provider or cache; every cache/vector/embed failure
  degrades to MISS; semantic path is non-stream only; exact-before-semantic order is fixed.
- **Why:** Isolation: the protocol edge owns protocol concerns so providers/caches can
  evolve without touching the contract.

### Provider adapters (`src/providers/*`)

- **Responsibility:** Translate canonical ChatRequest/ChatResponse to/from each provider's
  wire format; normalize errors and usage. Adapters never decide routing/auth-policy/retry.
- **Inputs:** Canonical `ChatRequest` + `AbortSignal`.
- **Outputs:** `ChatResponse` (chat) or `AsyncIterable<StreamChunk>` (chatStream) —
  content deltas + optional usage; `GatewayError` on failure.
- **Dependencies:** infrastructure/errors (classification), domain/types. No cache or
  policy imports.
- **Interface:** `ProviderAdapter { name, chat(req, signal), chatStream(req, signal) }`;
  factories: `createProviderFromEnv`, `createProvidersFromEnv`, `providerForModel`
  (prefix routing: `gpt-*`→openai, `claude-*`→anthropic, `gemini-*`→gemini,
  `llama*`/`nomic*`→ollama, else default).
- **Constraints:** Usage preserved-or-absent (never invented); errors never leak SDK
  internals; `max_tokens` defaults are per-adapter explicit (Anthropic 1024).
- **Why:** One interface = swappable providers; the adapter wire contracts are pinned by
  the fake-upstream e2e suite (`tests/e2e/upstream-adapters.e2e.test.ts`).

### Exact cache (`src/cache/CacheRepository.ts`, `InMemoryCache.ts`, `RedisCache.ts`, `factory.ts`)

- **Responsibility:** Cache-aside storage of normalized responses keyed by canonical identity.
- **Inputs:** `llm:exact:v1:<provider>:<sha256>` key + JSON payload (content, model, usage,
  cachedAt).
- **Outputs:** Cached payload string or null; ping/close.
- **Dependencies:** ioredis (only when `REDIS_URL` set); none otherwise.
- **Interface:** `CacheRepository { name, get, set(key, value, ttlSeconds), del, ping, close }`;
  `createCacheFromEnv`.
- **Constraints:** LRU bound 1000 entries (in-memory); TTL `CACHE_TTL_S`; failures degrade
  to MISS + counters.
- **Why:** $0 on identical requests; bounded memory without infrastructure in dev.

### Semantic cache (`src/cache/SemanticCacheStore.ts`, `InMemoryVectorStore.ts`, `PgVectorStore.ts`, `semanticFactory.ts`)

- **Responsibility:** Similarity search over past answers with tenant/provider/model
  isolation and expiry.
- **Inputs:** Query embedding (768-d), `SemanticFilter{tenant, provider, model}`,
  `{threshold, topK}`.
- **Outputs:** `SemanticHit[]` (id, promptText, content, usage?, temperature, maxTokens?,
  model, provider, similarity) ranked by cosine.
- **Dependencies:** pg (only for pgvector backend); EMBEDDING_DIM constant.
- **Interface:** `SemanticCacheStore { name, findSimilar, save, recordHit, ping, close }`;
  entries keyed UNIQUE `(tenant_id, provider, model, prompt_hash)`.
- **Constraints:** Dim mismatch → refuse row/save; pgvector missing extension → loud boot
  failure; store never returns cross-tenant rows.
- **Why:** Paraphrase recall without coupling lookup semantics to a backend; policy (not
  SQL alone) stays the safety authority.

### Embeddings (`src/embeddings/*`)

- **Responsibility:** Produce unit-comparable 768-d vectors for role-tagged prompt text.
- **Inputs:** `promptTextForEmbedding(req)` — `role: content` lines, trimmed,
  order-significant, system included.
- **Outputs:** `number[768]` or throw.
- **Dependencies:** None beyond fetch for Gemini/Ollama; the built-in `local` provider loads a
  quantized ONNX sentence-transformer (`Xenova/all-mpnet-base-v2`) in-process and needs no key.
- **Interface:** `EmbeddingProvider { name, dimension, embed(text, signal) }`;
  `createEmbedderFromEnv`; `EMBEDDING_DIM = 768`.
- **Constraints:** Model identity is NOT embedded (stays a hard filter); wrong-dim output throws.
- **Why:** Comparable vector space across models; deterministic mock keeps tests offline
  and safe.

### Reuse policy (`src/policy/reuse.ts`)

- **Responsibility:** Decide SAFE vs UNSAFE for a retrieved candidate. Pure function, no I/O.
- **Inputs:** `ChatRequest`, `SemanticHit`, `{provider, threshold}`.
- **Outputs:** `{reusable, reason}` — reasons: `provider-mismatch`, `model-mismatch`,
  `temperature-mismatch`, `max-tokens-mismatch`, `below-threshold`, `empty-content`, `ok`.
- **Dependencies:** Types only.
- **Interface:** `isReusableSemantic(req, candidate, opts)` — defense in depth: re-checks
  everything the store query filtered.
- **Constraints:** Never serve on `reusable:false`; pure (no I/O) for eval reproducibility.
  Reasons include `provider-mismatch`, `tenant-mismatch`, `model-mismatch`,
  `temperature-mismatch`, `max-tokens-mismatch`, `system-fingerprint-mismatch`,
  `policy-version-mismatch`, `below-threshold`, `empty-content` (T16 shipped).
- **Why:** Retrieval finds CLOSE; policy decides SAFE (banking 99%-FP lesson).

### Single-flight (`src/cache/SingleFlight.ts`)

- **Responsibility:** Coalesce N identical concurrent misses into one provider call.
- **Inputs:** Exact cache key + async factory.
- **Outputs:** Shared promise; follower count.
- **Dependencies:** None.
- **Interface:** `SingleFlight<T>{ run(key, fn), has, size, clear, coalesced, leaders }`.
- **Constraints:** Failures never poison the map; waiter abort never kills shared work
  (INV-4); single-process only.
- **Why:** Stampede protection without distributed locks.

### Response normalizer (`src/domain/responseNormalizer.ts`)

- **Responsibility:** Strip presentation markup before admission so one answer has one
  spelling in every store; stream-safe with bounded hold-back.
- **Inputs:** Raw provider content or stream deltas.
- **Outputs:** Normalized text (deterministic, non-destructive; code bodies kept verbatim).
- **Dependencies:** None (pure).
- **Interface:** `normalizeResponseText`, `normalizeChatContent`,
  `StreamingResponseNormalizer{ push, flush, pending }`.
- **Constraints:** Never emit an undecided construct; at most one partial line of extra
  latency; between-chunk whitespace preserved.
- **Why:** Two spellings of one answer must never occupy two cache entries; streams must
  not leak markup closers.

### Observability (`src/observability/metrics.ts`, `src/infrastructure/logger.ts`)

- **Responsibility:** Process-lifetime counters + derived snapshot; one-line JSON logs.
- **Inputs:** `inc/observe*` calls from the route; log fields.
- **Outputs:** `GET /metrics` snapshot; `GET /health`; `GET /providers`; console JSON lines.
- **Dependencies:** None (stdlib).
- **Interface:** `GatewayMetrics{ inc, observeCacheLookup, observeProviderLatency, observeSemanticScore, snapshot, reset }`;
  `log(fields)`.
- **Constraints:** Never throws; no keys/prompt text in logs; Prometheus is a follow-up.
- **Why:** Operators see hits/misses/avoided spend without reading app logs.

### Auth (`src/auth/*`, `src/api/routes/register.ts`, `src/api/routes/usage.ts`, `src/api/routes/connections.ts`)

- **Responsibility:** Two lanes on one chat endpoint. Registered lane (gateway key) gets the full cache pipeline plus per-tenant usage; anonymous lane (provider-key header) gets a try-out path with cache bypass and global counters only. Registered tenants can store their own upstream credential per provider (BYO key + optional base URL) via `POST /v1/connections`.
- **Inputs:** `Authorization: Bearer <gateway-key>` (alias `x-api-key`) or `x-provider-key: <upstream-key>`; `GATEWAY_API_KEYS` seed and `CRED_ENC_KEY` from config; `POST /v1/register` / `POST /v1/connections` bodies (`provider`, `provider_key`, optional `base_url` — http/https only).
- **Outputs:** `request.auth` (tenant, provider) or anonymous context; `x-lane` plus `x-key-id` evidence headers; `POST /v1/register` issues a `lg_` key once; `GET /v1/usage` returns the caller tenant slice; `POST /v1/connections` upserts one credential (a reconnect replaces key and URL), `GET /v1/connections` lists metadata only — provider, base_url, effective endpoint, created_at; never key material.
- **Dependencies:** `ApiKeyStore` (`verify`, `create`, `list`, `revoke`, `rotate`), `CredentialStore` (`save`, `get`, `list`, `remove`); `laneGuard` preHandler.
- **Interface:** `laneGuard` — gateway key present goes registered, else provider key goes anonymous, else 401 with register hint.
- **Constraints:** Lane pick runs before validation, provider, and cache; serving provider must equal key provider else 403 — a matching tenant credential for the serving provider bypasses that check (operator env keys stay protected); a configured routed provider with no key anywhere → `401 provider_key_missing` (connect hint; checked before the 403); a routed provider with no adapter in the process at all falls back to the configured default provider (zero-setup mock default — the legacy UI and fresh web checkout rely on this); `x-tenant-id` always ignored; no key material in logs, metrics, health, or usage.
- **Why:** Try-out traffic never touches server keys or cache entries; settled users get savings plus attributed numbers; BYO credentials let one gateway key serve any provider the tenant connected — OpenRouter `:free` models work on a keyless gateway.

### Composition root (`src/server.ts`, `src/infrastructure/config.ts`)

- **Responsibility:** Parse ALL env into `GatewayConfig` (validated, loud on typos); wire
  config → providers → caches → embedder → auth stores → routes. Only file that owns `new` for infra
  (via factories).
- **Inputs:** `process.env`.
- **Outputs:** Configured Fastify app (buildServer sync for tests; buildServerAsync for
  pgvector boot + listen).
- **Dependencies:** Every factory; dotenv.
- **Interface:** `buildServer()`, `buildServerAsync()`, `loadConfig(env)`.
- **Constraints:** Secrets read only here; bad enum, bad `GATEWAY_API_KEYS` entry, or missing `CRED_ENC_KEY` with `DATABASE_URL` → process exit; a selected `gemini`/`openai`/`anthropic` default requires its env key, while `PROVIDER=openrouter` may boot keyless (tenant BYO connections, actionable 401 until then); `VITEST` guard prevents auto-listen.
- **Why:** Standardization: one parser, one wiring point, testable boot.

## Request Flow

Non-streaming request, end to end:

```text
POST /v1/chat/completions
  → Lane pick (gateway key: registered | provider key: anonymous | neither: 401, no spend)
  → Zod subset validation (model/messages/temperature/max_tokens/stream)
  → per-model routing selects the serving adapter
  → canonical key build (trim, sorted JSON, sha256 → x-cache-hash)
  → L1 exact lookup (hit → 200 x-cache:HIT; malformed → evict + miss)
  → L2 semantic lookup: embed → findSimilar → isReusableSemantic loop
      (hit → 200 x-cache:SEMANTIC_HIT + x-semantic-similarity)
  → single-flight leader/follower (followers: x-coalesced:true)
  → adapter call (own AbortController + upstream timeout)
  → normalize content → exact set + semantic save (best-effort)
  → 200 reply with evidence headers + metrics + log line
```

## Response Flow

- **Batch (`stream:false`):** single JSON body, OpenAI shape
  (`choices[0].message.content`, `usage` preserved-or-absent), evidence headers,
  `x-cache` = HIT / SEMANTIC_HIT / MISS / DISABLED.
- **Stream (`stream:true`):** caches bypassed (`x-cache:BYPASS`); socket hijacked; headers
  written on first chunk (`x-latency-ms` = time-to-first-token); deltas framed as SSE
  `data:` frames through the hold-back normalizer; terminal usage frame when reported;
  `data: [DONE]`; socket closed.
- **Pre-first-token failure:** real JSON error status on the raw socket (never a silent
  empty 200 stream).
- **Mid-stream failure:** headers already sent → close the stream; client keeps partial text.

## Data Flow

- Request state moves forward only: lane pick → validation → canonical form → lookups → provider →
  normalized form → admission → reply. No stage mutates an earlier stage's data.
- Cache writes: exact `set` after provider success (JSON payload: content, model, usage,
  cachedAt); semantic `save` upserting on `(tenant_id, provider, model, prompt_hash)` with
  TTL, reusing the lookup embedding when available. Both best-effort — write failure never
  fails the request.
- Metrics: route increments counters and observes latencies; `snapshot()` derives
  rates/averages/avoided-calls on read.
- Embeddings: prompt text → 768-d vector (validated dimension) → used for search, then
  stored alongside the answer (raw + vector together).

## Interfaces/Contracts

- `POST /v1/chat/completions`: registered (`Authorization: Bearer <gateway-key>`, alias `x-api-key`)
  or anonymous (`x-provider-key: <upstream-key>`); body `{model (required, non-empty), messages (1+, role
  system|user|assistant, non-empty content), temperature (0–2, default 1.0), max_tokens
  (optional positive int), stream (default false)}`. No key → `401` with register hint, no spend. Invalid →
  `400 {error:{code,message,request_id}}`, no provider call, no cache touch.
- `POST /v1/register` (open): body `{ name, provider, provider_key, base_url? }` (`base_url` http/https
  only, pins the tenant's own upstream endpoint) → `201`
  `{ tenant_id, provider, key (once), key_prefix }`; `400` on validation or unknown provider.
- `POST /v1/connections` (gateway key): body `{ provider, provider_key, base_url? }` → `201`
  `{ provider, base_url, endpoint, connected }`; upserts one credential per
  `(tenant, provider)` — a reconnect replaces key and URL.
- `GET /v1/connections` (gateway key): `{ tenant_id, connections [{ provider, base_url,
  endpoint, created_at }] }` — metadata only, never key material.
- `GET /v1/usage` (gateway key): caller tenant slice only
  `{ tenant, requests, exact_hits, semantic_hits, misses, coalesced, hit_rate,
  provider_calls_avoided, latency_ms_total, avg_latency_ms }` (web client fields; the runbook's
  older `tenant_id`/`avg_provider_ms` names are not returned).
- Error vocabulary: timeout/abort → `504`; rate limit → `429` (+ parsed `retry_after`
  when present); upstream 5xx/auth/404 → `502`. Auth: missing or bad key → `401`;
  revoked, expired, or provider mismatch → `403`; routed provider with no key anywhere →
  `401 provider_key_missing` (connect your own key); store down → `503 auth_unavailable`.
  Upstream bodies never leak beyond a bounded snippet.
- Evidence headers on every validated reply: `x-request-id`, `x-provider`, `x-cache`,
  `x-cache-hash` (absent only on 400), `x-latency-ms`, `x-lane` (`registered` | `anonymous`);
  plus `x-key-id` on the registered lane, `x-semantic-similarity` on
  semantic hits, `x-coalesced` on coalesced followers.
- Tenant identity comes from the verified gateway key; `x-tenant-id` is always ignored.
  Semantic lookups stay scoped per tenant.
- `GET /health` (liveness + backend names + read-only tuning config, no secrets),
  `GET /metrics` (counters + derived rates, plus `auth_rejects_total`), `GET /providers` (id/label/endpoint/models/
  configured/active, never key values), `GET /` (static playground UI).

## Database/Storage Architecture

- **Exact cache:** `REDIS_URL` selects Redis, else bounded in-memory LRU (1000 entries, TTL
  `CACHE_TTL_S`, recency refresh). Key `llm:exact:v1:<provider>:<sha256>`. Malformed reads
  evicted, never served. The exact identity is `(serving provider, canonical request)` and is
  intentionally **not tenant-scoped** (all lanes share identical-request answers); the
  semantic layer is tenant-scoped.
- **Semantic cache:** `SEMANTIC_STORE=memory` (brute-force cosine, zero-setup) or `pgvector`
  (production). Table `semantic_cache`: `id, tenant_id, provider, model, prompt_hash,
  prompt_text, temperature, max_tokens, embedding vector(768), content, usage_prompt,
  usage_completion, created_at, expires_at, hits, system_fingerprint, policy_version`;
  UNIQUE `(tenant_id, provider, model, prompt_hash)`; HNSW cosine index for ANN +
  composite scope index on `(tenant_id, provider, model, expires_at)`. The runtime schema is
  the embedded DDL in `src/cache/PgVectorStore.ts` (`migrateSemanticCache`) and
  `src/auth/PgAuthStores.ts` (`migrateAuthTables`), applied at boot; missing vector extension
  fails loud. `db/migrations/*.sql` are reference mirrors of that DDL, not a runner input.
- **Eviction/expiry:** TTL on both stores (expired reads = misses); in-memory LRU caps
  (exact 1000, semantic 2000) with `recordHit` recency; dedupe on prompt_hash; double-write
  failure never fails the request. pgvector rows are filtered by `expires_at` but not purged
  by a background job yet (known limit, documented in README).
- **Auth:** tables `api_keys` (`key_hash UNIQUE`, expiry/revocation columns) and
  `provider_credentials` (`PRIMARY KEY (tenant_id, provider)`, encrypted key only +
  nullable `base_url`), created by the embedded auth DDL at boot. Gateway keys are `lg_`
  plus 32B base64url; only sha256 hex is stored and plaintext is shown once at register.

## External Integrations

- **Providers (outbound fetch, no SDKs):** mock (in-process, delay + failure injection for
  tests); one OpenAI-compatible adapter (`POST {base}/chat/completions`,
  `stream_options.include_usage`, one retry without it on 400) serving OpenAI/Gemini/Ollama
  and OpenRouter (`:free`/`openrouter/` models route to it; `:free` is $0 but still needs a
  free account key); dedicated Anthropic adapter (system folding, content blocks, token-name
  mapping).
  Per-model prefix routing with fallback to the configured default. Only the selected
  provider needs its key; `DATABASE_URL` only for pgvector. Adapters declare their feature
  set (`capabilities`) and the HTTP layer rejects undeclared needs with
  `400 unsupported_capability` before dispatch (T8).
- **Embedders:** mock (deterministic), local (built-in ONNX, no key/server),
  gemini (`:embedContent`), ollama (`/api/embeddings`); selected by `EMBEDDING_PROVIDER`.
- **Infrastructure:** Redis (optional, via `REDIS_URL`); Postgres+pgvector (optional, via
  `DATABASE_URL`). Absent backing services degrade to in-memory or MISS — never a boot
  failure (except pgvector misconfiguration, which fails loud).

## Error Handling

- Validation failures → 400 before any spend (INV-1); missing or bad lane → 401/403/503 before any spend (INV-9).
- Provider failures → `GatewayError` via `toGatewayError`/`providerHttpError`: 429→429
  (retryable), 401/403/404→502 (not retryable), 5xx→502 (retryable), Abort→504
  (retryable); bounded snippet only, never raw internals.
- Client abort (response socket close before writableEnded) → upstream AbortController
  fires; waiters reject individually (504 `gateway_timeout`), shared work survives.
- Cache/embedding/vector failures → MISS/skip + failure counters; never 5xx (INV-2).
- SSE: pre-first-token failure → JSON error status on the raw socket; mid-stream failure →
  close stream (headers already sent).
- 429 messages with parseable retry hints → `retry_after` surfaced.

## Concurrency Considerations

- Single-flight keyed by exact cache key (provider-scoped); leaders/followers counted;
  `awaitShared` isolates waiter aborts.
- Upstream runs on its own controller: client disconnect ≠ shared cancel; timeout timer
  cleared in `finally`.
- In-memory stores: synchronous mutation under Node's single-threaded event loop; no locks
  needed; vector store sweeps expired rows on access.

## Performance Considerations

- Cache lookups are timed (`avg_cache_lookup_ms`); provider latency observed per call.
- Brute-force vector scan is O(n) — fine at LRU-bound scale; pgvector HNSW for production.
- Streaming hold-back adds at most one partial line of latency; bounded tail window keeps
  literal mid-text markers from stalling.
- sha256 over canonical JSON is the only per-request crypto cost.

## Security Considerations

- Gateway and provider keys never logged, never echoed by `/health`/`/providers`/`/metrics`/`/usage`; prompts/responses never logged. Provider keys stored encrypted, never returned.
- Lane pick runs before validation, provider, and cache: no lane means 401 with a register hint and no spend. Registered requests serve only their key provider (else 403); anonymous requests use only the header key and bypass caches.
- CORS limited to the four API routes; static assets same-origin; path traversal guarded in
  the playground file server.
- Tenant identity comes from the verified key only (`x-tenant-id` ignored); usage numbers are per tenant.
- Upstream error snippets truncated to 300 chars.

## Architectural Constraints

- Modular monolith; module boundaries per component Dependencies above (api depends on
  ports, never SDKs).
- Invariants (every change): INV-1 invalid → 400, no provider, no cache touch ·
  INV-2 cache/vector/embed failure → MISS/skip, never user error ·
  INV-3 N identical misses → 1 provider call ·
  INV-4 waiter abort never kills shared work ·
  INV-5 `x-cache-hash` on every validated reply ·
  INV-6 semantic HIT only if policy `reusable:true` ·
  INV-7 fallback answers cached under serving key only ·
  INV-8 errors/empty never admitted ·
  INV-9 no lane → 401 with no spend; serving provider must equal key provider; anonymous uses header key only, cache BYPASS.

## Decision Register (ADR index)

Decisions made via the GATE→LOCK loop (§2 below); the owner appends locked decisions here.

| ADR | Decision | Invariant (testable) |
| --- | --- | --- |
| ADR-001 | Modular monolith first; api depends on ports, never SDKs | No direct SDK/fetch import under `src/api` |
| ADR-003 | Cache-aside exact cache; Redis when configured, in-memory LRU otherwise | Cache failure degrades to MISS, never 5xx |
| ADR-004 | Pluggable semantic store port (memory brute-force / pgvector HNSW) | Store swap changes no lookup semantics |
| ADR-005 | pgvector fails loud at boot on missing extension | Typo/misconfig never boots a silently degraded server |

Numbers are stable identifiers; gaps are retired entries — never reuse a number.

## Implementation guidance (researched patterns, mapped to this repo)

- **Savings layers:** (1) Exact gateway cache → $0 on identical `(model, messages, params)`,
  key ignores JSON formatting noise. (2) Semantic gateway cache → $0 on paraphrases
  (pays embedding + lookup, saves the LLM call; needs threshold defense). (3) Provider
  prompt cache → discount, not $0 (not yet exposed).
- **GPTCache pattern:** adapter → pre-processor (canonicalize) → embedding generator
  (pluggable) → cache manager (relational + vector store) → similarity evaluator (top-K +
  threshold) → post-processor (normalize answer). Mapping: `src/api` = adapter;
  `src/domain/*normalize*` = pre/post-processor; `src/embeddings/*` = embedding generator;
  `src/cache/*Cache* + SemanticCacheStore` = cache manager; `src/policy/reuse.ts` =
  similarity-evaluator gate; threshold/topK/TTL from `src/infrastructure/config.ts`.
  Copy: exact-before-semantic order; store raw + vector together; never serve errors/empty;
  LRU eviction; `memory` brute-force for tests, `pgvector` HNSW for prod.
- **Reuse safety:** score = cosine on unit vectors. Retrieval ≠ decision: store query
  filters `tenant/provider/model` first, then the policy re-checks in code (defense in
  depth). Banking lesson: low defaults gave ~99% FP on some models; near-miss distractors
  (topical 0.8–0.9, semantic near-miss 0.85–0.95) must be in the eval set. Admit only
  successful, non-empty, normalized responses with `usage` preserved-or-absent.
- **Fallback (T14, shipped):** ordered target list → transient retry (429/5xx/timeout,
  exp backoff + jitter) → failover → per-target breaker (open after N fails, cooldown
  skip) → `502` when exhausted. `x-provider` = serving target, `x-fallback:true` on
  failover. Streaming failover only before first token. Cache under serving-provider key.
  The chain is only built for provider-agnostic model ids: a model that names a provider
  (`gpt-*`, `*:free`, …) retries/fails inside that provider, because another vendor would
  404 the foreign id and mask the real error (live-reproduced). The in-process mock is only
  registered when it is the configured default provider, so a real deployment can never
  answer a failed request with fabricated mock content.
- **Canonical request/response:** trim model + content (inner whitespace significant),
  message order significant, temperature default 1.0, `max_tokens` omitted-when-absent,
  `stream` excluded from key; Anthropic folds ALL system messages into native `system`;
  normalize (`normalizeResponseText()` + hold-back streaming normalizer) BEFORE cache
  admission; `usage` preserved when reported, `undefined` otherwise. Capability declarations
  make unsupported requests an explicit `400`.
- **Eval (T15, shipped):** no threshold ships without data — labeled versioned dataset
  (duplicates / paraphrases / near-miss / cross-domain / system-change / tenant-change),
  sweep 0.60→0.95 reporting precision/recall/FP/FN, safe-reuse rate, latency + $ saved,
  cost-aware optimum locked in config with a report link (`evaluation/report.md`).

---

# PART C — Mandatory loop (every task, no skipping)

```text
1. Read Product (this file, Part A — full section)
2. Read Architecture (this file, Part B — full section, including invariants)
3. Read the ONE task from agent/loop.md §Tasks; if its Status is completed, do NOT re-implement
4. Read current diff + the task's listed tests
5. State in one sentence: task ID + what changes
6. List invariants (Part B §Architectural Constraints) this task must not break
7. List failure modes for this task (timeout, 429, 5xx, abort, Redis down, malformed entry)
8. Propose minimal file list -> STOP and ask if ambiguous
9. Implement smallest diff (no public API change, no new dep without why, no scope beyond the task)
10. Write/run tests per agent/tests.md + task Testing Requirements
11. Diff implementation vs Part B -> report deviations
12. STOP on ambiguity — propose 2 options, ask. Found extra work? Log as a candidate task, do NOT fold in
```

Then:

- Implement only the requested task.
- Follow the architecture.
- Keep scope limited.
- Reuse existing abstractions where appropriate.
- Do not introduce unnecessary dependencies.
- Do not redesign the architecture.

If there is an architecture conflict, stop and report it.

# PART D — GATE → LOCK (one decision per pass)

- **GATE:** State the question in one sentence and the failure mode if answered wrong. Can't
  state the failure mode? You don't understand the problem — STOP.
- **DECIDE:** Choice + rejected alternative (with the exact mechanism of failure — "it's
  worse" is an opinion, not an argument) + one testable invariant. Missing any of the
  three? Not ready.
- **SPEC:** The decision becomes a contract — interface, schema, headers. No logic. Can't
  write the contract cleanly? Back to DECIDE.
- **IMPLEMENT:** One task, smallest slice satisfying the spec. Found something else? Log it
  as its own decision — scope creep by stealth is how systems rot.
- **VERIFY:** Test the invariant directly, explicitly. A test that cannot fail is theater —
  sharpen it.
- **LOCK:** VERIFY passes → the decision is closed. Changing a locked decision = a new GATE,
  not an edit. This is the paper trail that prevents silent drift.

### Decision log format

Each pass records its entry in its FINAL REPORT; the owner promotes locked decisions to the
Decision Register in Part B above:

```text
### [ID] Short title
- Context:
- Choice:
- Rejected:
- Invariant:
- Status: open | verified | locked
```

# PART E — When the architecture is wrong

Report `ARCHITECTURE_CONFLICT` exactly per the protocol below (Problem / Affected Area /
Why / Required Decision) and STOP. The agent must NOT:

- Redesign the architecture or its boundaries without approval.
- Introduce unnecessary abstractions or dependencies.
- Modify unrelated code.
- Modify architecture documents to justify implementation.
- Mark a task complete before tests and review pass.

```text
ARCHITECTURE_CONFLICT

Problem: <what contradicts what>

Affected Area: <component + file>

Why: <failure mode if the architecture is followed / if it is silently changed>

Required Decision: <the specific question for the developer>
```

Then stop and wait for the developer. Do not invent a new architecture, and do not edit
Part B to justify code.

# PART F — Non-negotiables

1. No code without a task ID from `agent/loop.md` §Tasks.
2. No batching task IDs in one pass.
3. No invented requirements. Ambiguous → ask with 2 options (`blocked` if information is missing).
4. No scope creep. Extras logged separately.
5. No feeling-based pass/fail. Show the test.
6. Locked stays locked.
7. No commit/push without explicit user approval (Part G).

# PART G — Test-before-present + approve-to-commit gate

## Test-before-present (every task, before showing the user)

Summary — full rules in `agent/tests.md`, full sequence in `agent/loop.md`.

1. Map every Acceptance Criterion in the task to ≥1 test. A bullet with no test = failure.
2. Enumerate before coding per `agent/tests.md` §1: happy / error / edge / boundary /
   invalid input / dependency failures (Redis down, embedder down, 429/5xx/timeout) /
   concurrency where relevant / regression risks.
3. Run, in this order:
   ```powershell
   npm test                  # offline: unit + integration + contract
   npm run typecheck         # tsc --noEmit -p tsconfig.check.json
   $env:GEMINI_API_KEY=""; npm test  # guaranteed-offline proof (live test must skip without key)
   # npm run test:live       # ONLY if the task explicitly says live (needs $env:GEMINI_API_KEY)
   ```
4. Review your own diff first: `git status --short`, `git diff --stat`, `git diff` —
   confirm only the task's file scope changed.
5. Self-review against `agent/review.md` §1–§4 before presenting (arch compliance / task
   compliance / test compliance / code quality).
6. Present this bundle to the user — nothing less:
   ```text
   Task: <T-ID + title> + one-sentence change
   Changed: <files + why>
   Invariants: <INV-x list, unbroken>
   Tests run: npm test + typecheck (+ offline proof) with counts (run/passed/failed)
   Acceptance: <each criterion -> test name / observable behavior>
   Arch deviations: <none | ARCHITECTURE_CONFLICT per Part E protocol>
   Status: <in_progress | testing | review> — never flip to completed yet
   Risks / extras: <risks + candidate tasks, not folded in>
   Awaiting approval to commit.
   ```
7. Never present as done while tests/typecheck fail. Never delete or weaken assertions to
   make a suite pass.

## Approve-to-commit gate (manual approval required)

No auto-commit. No auto-push. Code stays uncommitted until the user explicitly approves.

1. After test-before-present, STOP. Wait for clear approval: the words `approve`,
   `commit`, or `push`, or unambiguous intent such as "yes, commit".
   Anything ambiguous = no commit.
2. On approval, re-verify fast (suite may have drifted):
   ```powershell
   git status --short
   npm test
   npm run typecheck
   ```
   Green on both → proceed. Red → report, do not commit.
3. Commit once per task:
   ```bash
   git add <task files + tests only>
   git commit -m "<T-ID>: <short title>

   <what + why, 1-2 lines. Tests: <counts> pass, typecheck clean.>"
   ```
   One task per commit. Never batch task IDs. Never commit secrets/`.env`.
4. Push only on explicit `push` approval (or `approve push`): `git push origin <branch>`.
   Default is commit-local + stop; show `git log -1 --stat` and `git status --short` as proof.
5. Task Status in `agent/loop.md` §Tasks flips to `completed` only when the loop
   completion rule holds (implementation + tests + acceptance + architecture review + code
   review, all passing) — on reviewer verdict `PASS` (`agent/review.md` §6) the owner
   flips Status. No one else flips it.

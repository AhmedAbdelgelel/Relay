# Implementation spec (minimal)

Relay is an OpenAI-compatible LLM gateway that cuts cost/latency by reusing safe
answers, without ever returning a wrong one. This file is the short source of
truth for product scope, architecture and invariants. Task history lives in
`agent/loop.md`; testing rules in `agent/tests.md`; review protocol in
`agent/review.md`.

## 1. Product

**Goal:** accept OpenAI-style chat requests, serve identical prompts from an
exact cache and safe paraphrases from a semantic cache, otherwise call a
provider; expose evidence for every decision.

**Problem:** repeated prompts waste money/latency, but *similar* ≠ *equivalent*.
Reuse must be explicit, policy-checked and measurable.

**Functional requirements**

1. Valid request → provider response (or cache hit) with evidence headers.
2. Invalid request → `400` before any provider/cache spend.
3. Exact repeat → `x-cache: HIT`, provider not called.
4. Paraphrase that passes policy → `SEMANTIC_HIT` + similarity header.
5. Unsafe/unrelated/temperature/model/tenant drift → `MISS` (no false reuse).
6. N concurrent identical misses → exactly one provider call (single-flight).
7. Streams: SSE frames, terminal usage, `[DONE]`, pre-first-token errors are JSON.
8. Cache/embedder failure degrades to `MISS`; never a cache-caused 5xx.
9. Two access lanes: registered gateway key (cache + per-tenant usage) and
   anonymous try-out (`x-provider-key`, always `BYPASS`).
10. `/metrics`, `/health`, `/providers` and per-tenant `/v1/usage` are truthful.

**Non-goals:** Prometheus/tracing export, rate limits/quotas, multi-region,
distributed single-flight, scheduled pgvector purge, provider prompt-cache
discounts.

## 2. Pipeline

```
request
  → lane guard (gateway key = registered | x-provider-key = anonymous | 401)
  → validation (400 before spend)
  → canonical request → sha256 → x-cache-hash
  → L1 exact cache (memory LRU | Redis)
  → L2 semantic lookup (embed → top-K → pure reuse policy)
  → single-flight (key = exact key; waiter abort never kills shared work)
  → provider chain (retry/backoff, per-target circuit breaker, no fallback for
    provider-specific model ids)
  → normalize content
  → admit non-empty success to L1 + L2 (best-effort)
  → reply with evidence headers (or SSE frames when stream:true)
```

Order is fixed: exact before semantic; streams bypass both caches.

## 3. Components (ports-and-adapters)

| Component | Responsibility / interface |
|---|---|
| `src/api/routes/chat.ts` | HTTP only: validate, lane guard, orchestrate pipeline, headers, SSE, error map. Dependencies injected (`providers`, `cache`, `semanticStore`, `embedder`, `auth`). |
| `src/providers/*` | `ProviderAdapter{name,configured,capabilities,chat,chatStream}`. Factories + `routeProviderName` (prefix routing) + capability gate. No cache/policy imports. |
| `src/cache/*` | `CacheRepository{get,set,del,ping}` (memory/Redis); `SemanticCacheStore{findSimilar,save,recordHit}` (memory vector/pgvector); `SingleFlight`. Bounded memory caps: exact 1000, semantic 2000. |
| `src/embeddings/*` | `EmbeddingProvider{name,dimension,embed}`; 768-d; providers: local ONNX (default), Gemini, Ollama, mock. Wrong dim/non-finite throws. |
| `src/policy/reuse.ts` | Pure `isReusableSemantic(req, hit, {provider,threshold,tenant})`; checks provider, tenant, model, temperature, max_tokens, system fingerprint, policy version, threshold, empty content. |
| `src/routing/fallback.ts` | `buildChain`, `executeChain`, `TargetBreaker`; `buildChain` never duplicates a provider name. |
| `src/auth/*` | Key/credential ports + memory/PG implementations; lane guard; SHA-256 hashed gateway keys; AES-256-GCM provider credentials. |
| `src/domain/*` | Types, canonical key/hash, response normalization (markup stripped pre-admission; stream-safe hold-back). |
| `src/observability/*` | Process metrics snapshot; JSON logs (no prompts/keys). |
| `src/infrastructure/config.ts` | Only env parser; fail-fast on typos; all defaults documented in `.env.example`. |
| `src/server.ts` | Composition root (`buildServer` for tests, `buildServerAsync` for boot). |
| `web/` | Next.js 16 control plane: playground, cache evidence, request inspector, cache page, providers/connections, settings. Same-origin proxy via `GATEWAY_URL`. |

## 4. Invariants (every change)

- **INV-1** invalid input → 400 before provider/cache.
- **INV-2** cache/vector/embed failure → MISS/degrade, never user-facing 5xx.
- **INV-3** N concurrent identical misses → 1 provider call.
- **INV-4** a coalesced waiter's abort never aborts shared work.
- **INV-5** every validated reply carries `x-request-id`; non-stream replies also
  `x-provider`, `x-cache`, `x-cache-hash`, `x-latency-ms`, `x-lane`.
- **INV-6** semantic HIT only when policy returns `reusable:true`.
- **INV-7** fallback answers are cached under the serving provider key only.
- **INV-8** errors/empty content are never admitted to either cache.
- **INV-9** no lane → 401 no spend; registered key provider must match serving
  provider (unless the tenant connected its own credential); anonymous uses only
  the header key and always BYPASSes caches.

## 5. HTTP contract

All errors: `{ error: { code, message, request_id } }`, `x-request-id` echoed.

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| POST | `/v1/chat/completions` | Bearer `lg_…` / `x-api-key` or `x-provider-key` | `{model, messages[], temperature?=1, max_tokens?, stream?=false}` | `200` OpenAI shape + evidence headers; SSE when stream | `400` invalid/unsupported capability; `401` missing/bad key/provider key; `403` revoked/expired/provider mismatch; `429` rate limit; `502` provider; `503` auth store; `504` timeout |
| POST | `/v1/register` | open | `{name, provider, provider_key, base_url?}` | `201 {tenant_id, provider, key, key_prefix}` (key shown once) | `400` validation; `503` store |
| GET | `/v1/usage` | registered | — | `200 {tenant, requests, exact_hits, semantic_hits, misses, coalesced, hit_rate, provider_calls_avoided, latency_ms_total, avg_latency_ms}` | `401`; `403` |
| POST | `/v1/connections` | registered | `{provider, provider_key, base_url?}` | `201 {provider, base_url, endpoint, connected}` | `400`; `401`; `403`; `503` |
| GET | `/v1/connections` | registered | — | `200 {tenant_id, connections[{provider,base_url,endpoint,created_at}]}` (metadata only) | `401`; `403`; `503` |
| GET | `/health` | public | — | `{ok, provider, cache, semantic, embedder, config}` | — |
| GET | `/metrics` | public | — | counters + derived rates (see runbook) | — |
| GET | `/providers` | public | — | `[{id,label,endpoint,models[],configured,active}]` | — |
| GET | `/`, `/styles.css`, `/js/:name` | public | — | legacy playground statics | `403` traversal, `404` missing |

Semantics:
- `x-cache`: `HIT | SEMANTIC_HIT | MISS | BYPASS | DISABLED`; stream always BYPASS.
- Anonymous lane never reads/writes cache and has no tenant accounting.
- Provider-specific model ids (`gpt-*`, `claude-*`, `gemini-*`, `llama*`,
  `openrouter/*`, `*:free`) route to that provider; fallback never sends them to
  another vendor.
- No key anywhere for a configured routed provider → `401 provider_key_missing`.
- Health/providers/metrics/usage/errors never contain key material.
- `x-tenant-id` is ignored; tenant identity comes from the verified gateway key.

## 6. Storage / data

- Exact cache: key `llm:exact:v1:<provider>:<sha256(canonical request)>`; memory
  LRU or Redis; TTL `CACHE_TTL_S`; malformed/blank entries evicted on read.
  Identity is provider+request (not tenant-scoped — documented product choice).
- Semantic cache: memory vector store or pgvector. Table `semantic_cache` with
  `(tenant_id, provider, model, prompt_hash)` unique, embedding `vector(768)`,
  system_fingerprint, policy_version, expiry/hits. Runtime DDL lives in
  `src/cache/PgVectorStore.ts` + `src/auth/PgAuthStores.ts`; `db/migrations/*`
  are reference mirrors (not executed). Rows expire logically; no purge job.
- Auth: `api_keys` (hash only, expiry/revocation) and `provider_credentials`
  (encrypted key + nullable base_url), PG via `DATABASE_URL` + `CRED_ENC_KEY`;
  otherwise in-memory.
- Redis is a cache; losing it degrades to MISS, never wrong answers.

## 7. Security (see SECURITY.md)

Two lanes; no secrets in logs/health/metrics/usage; gateway keys hashed, provider
keys AES-256-GCM encrypted; semantic reuse re-checks tenant; exact cache shared
across tenants by design; open registration and BYO `base_url` are deliberate
capabilities with known limitations (no rate limits, SSRF surface, UI unauthenticated).

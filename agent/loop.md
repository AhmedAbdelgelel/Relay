# Loop (tasks + end-to-end cycle + runbook)

> The complete cycle one task goes through, end to end. Product + Architecture live in
> `agent/implementation.md` (Parts A–B). Task definitions live in §Tasks below.
> Personas: `agent/implementation.md` (implement), `agent/tests.md` (test),
> `agent/review.md` (review). Product + architecture + task definitions stay human-owned.
> Statuses below are the live record.

```text
Select Task (from §Tasks below, status = pending)
    ↓
Read Product ──── agent/implementation.md Part A
    ↓
Read Architecture agent/implementation.md Part B (invariants!)
    ↓
Read Task ──────── the ONE task: Goal/Requirements/Acceptance/Testing/Dependencies
    ↓
Inspect Existing Code (abstractions, diff, listed tests)
    ↓
[understood?] ── NO ──> BLOCKED: state exactly what information is missing
    ↓ YES
Implement (smallest diff, GATE→LOCK per decision)
    ↓
Write Tests (per task Testing Requirements + tests.md §1 enumeration)
    ↓
Run Tests (npm test offline + npm run typecheck; live only if the task says)
    ↓
Review Code + Tests (agent/review.md against Part A / Part B / task)
    ↓
PASS?
  ├── NO → Fix → Test → Review
  │
  └── YES → Complete Task
```

## Step 1 — Understand

Before changing code: read product, architecture, the task, and the existing implementation.
Verify the task is sufficiently defined (requirements + acceptance + testing all stated).
If not → `blocked` with the missing information named. Ambiguity → 2 options, ask.

## Step 2 — Implement

Only the current task. No redesign, no speculative functionality, no architecture edits.
Decisions go through GATE→LOCK (`agent/implementation.md` Part D) with the decision logged.

## Step 3 — Test

Create tests according to: task Testing Requirements + Acceptance Criteria + architecture
invariants. Run the layers that apply (`agent/tests.md` §2–§3) — unit by default,
integration/contract for wiring, E2E sparingly. Do not create unnecessary E2E tests for
every small function.

## Step 4 — Review

Review implementation AND tests against product/architecture/task/acceptance
(`agent/review.md` §1–§4). The reviewer runs the suite themselves.

## Step 5 — Fix

On `CHANGES_REQUIRED`: fix the named issues → rerun tests → review again. Repeat until
`PASS`. Severity-blocker issues cannot be waived.

## Task Completion Rule

A task can only become `completed` when:

```text
Implementation complete
AND
Tests pass
AND
Acceptance criteria pass
AND
Architecture review passes
AND
Code review passes
```

Otherwise it stays `pending | in_progress | testing | review | blocked`. Completion is
recorded by flipping the task Status in §Tasks below.

---

# §Tasks

> Shipped tasks (T1–T13, T23) are `completed` and recorded here as history; open
> work (T14, T16, T15, T17–T21, T24–T27) is `pending` in dependency order.
> T22 is superseded by T23–T27 (Token mode). A task becomes
> `completed` only per the completion rule above. `Files:` lines declare each
> task's file scope for the scope check.

## T1 - HTTP contract + validation + error mapping

Status: completed

### Goal

Reject bad input before spend; one error vocabulary for every failure.

### Requirements

1. Zod subset `model, messages, temperature, max_tokens, stream`; `400/429/502/504`
   mapping; `{error:{code,message,request_id}}` + `x-request-id`; SSE pre-first-token errors.

### Related Architecture

`agent/implementation.md` Part B → HTTP layer; Error Handling; Interfaces/Contracts; INV-1, INV-5.

### Files

`src/api/routes/chat.ts`, `src/domain/types.ts`, `src/infrastructure/errors.ts`.

### Acceptance Criteria

- Valid request returns provider response with `x-request-id`.
- Invalid body → `400` before any provider call.
- Provider timeout → `504`; 429/500 → `429/502` without leaking SDK internals.

### Testing Requirements

- `tests/contract/chat.contract.test.ts`, `tests/integration/provider.test.ts`, `tests/integration/openai-errors.test.ts`.

### Dependencies

None — first task.

## T2 - ProviderAdapter + factories

Status: completed

### Goal

One swappable interface; adding a provider changes only the factory.

### Requirements

1. `ProviderAdapter {chat, chatStream}`; mock with delay + failure injection;
   OpenAI-compatible class for OpenAI/Gemini/Ollama; dedicated Anthropic adapter (system
   mapping, content blocks, token names); prefix routing (`gpt-*→openai`,
   `claude-*→anthropic`, `gemini-*→gemini`, `llama*/nomic*→ollama`).

### Related Architecture

`agent/implementation.md` Part B → Provider adapters; External Integrations.

### Files

`src/providers/*`.

### Acceptance Criteria

- Same canonical request → same canonical shape from all adapters; usage preserved-or-absent.
- Unknown model prefix falls back to the default provider.

### Testing Requirements

- `tests/integration/provider.test.ts`, `tests/integration/providers-routing.test.ts`.

### Dependencies

T1 (contract shape it translates).

## T3 - Normalize + canonical key + evidence header

Status: completed

### Goal

Deterministic request identity; formatting noise must not split/mix entries.

### Requirements

1. Trim + canonicalJson (sorted keys) → sha256 → `x-cache-hash` on every validated reply;
   exact key embeds the ACTIVE provider name.

### Related Architecture

`agent/implementation.md` Part B → Exact cache; Interfaces/Contracts; INV-5.

### Files

`src/domain/normalize.ts`.

### Acceptance Criteria

- Field-order/whitespace/default-temperature variants produce the same key;
  model/prompt/temperature changes produce different keys.

### Testing Requirements

- `tests/unit/normalize.test.ts`, `tests/integration/exact-cache.test.ts`.

### Dependencies

T1 (validated shape to canonicalize).

## T4 - Exact cache (Redis + InMemory LRU)

Status: completed

### Goal

$0 on identical requests; bounded memory even when Redis is absent.

### Requirements

1. `CacheRepository` port; `REDIS_URL` selects Redis, else 1000-entry LRU with TTL +
   recency refresh; malformed entries evicted, never served.

### Related Architecture

`agent/implementation.md` Part B → Exact cache; Database/Storage Architecture; INV-2, INV-8.

### Files

`src/cache/CacheRepository.ts`, `InMemoryCache.ts`, `RedisCache.ts`, `factory.ts`.

### Acceptance Criteria

- Repeat identical request → `x-cache:HIT`, provider avoided.
- Corrupt entry evicted and counted as miss; Redis outage stays invisible (MISS + counters).

### Testing Requirements

- `tests/unit/inmemory-eviction.test.ts`, `tests/integration/exact-cache.test.ts`.

### Dependencies

T3 (canonical key).

## T5 - Single-flight

Status: completed

### Goal

N identical concurrent misses must cost 1 provider call (stampede safety).

### Requirements

1. Per-key promise table keyed by exact cache key; followers `x-coalesced:true`; waiter
   abort rejects only that waiter (INV-4); failures never poison the map.

### Related Architecture

`agent/implementation.md` Part B → Single-flight; Concurrency Considerations; INV-3, INV-4.

### Files

`src/cache/SingleFlight.ts` + chat-route wiring.

### Acceptance Criteria

- 50 concurrent identical misses → 1 provider call, all 200; different prompts never coalesce.

### Testing Requirements

- `tests/unit/singleflight.test.ts`, `tests/integration/singleflight-stampede.test.ts`.

### Dependencies

T4 (miss path it coalesces).

## T6 - Streaming SSE + abort + usage

Status: completed

### Goal

Interactive clients need first-token latency and honest abort semantics.

### Requirements

1. SSE framing with headers on first chunk (pre-first-token errors stay JSON), terminal
   usage frame, `[DONE]`, client-disconnect aborts upstream, TTFT header.

### Related Architecture

`agent/implementation.md` Part B → Response Flow; HTTP layer; Error Handling.

### Files

`src/api/routes/chat.ts` (SSE path), providers' `chatStream`.

### Acceptance Criteria

- `stream:true` → SSE with `[DONE]`; disconnect aborts upstream; empty stream still closes cleanly.

### Testing Requirements

- `tests/integration/http-real.test.ts`, `tests/unit/chat-ui.test.ts`, live opt-in `tests/integration/gemini-live.test.ts`.

### Dependencies

T2 (adapter streams).

## T7 - Metrics baseline

Status: completed

### Goal

Operators must see hits/misses/avoided calls without reading logs.

### Requirements

1. JSON `GET /metrics` counters + derived rates; `/health`; `/providers`.

### Related Architecture

`agent/implementation.md` Part B → Observability; Interfaces/Contracts.

### Files

`src/observability/metrics.ts`, route endpoints.

### Acceptance Criteria

- HIT/MISS update `/metrics` with `hit_rate` + `provider_calls_avoided`; health reports
  live wiring.

### Testing Requirements

- `tests/unit/metrics.test.ts`, `tests/unit/control-plane-smoke.test.ts`.

### Dependencies

T4, T5 (events it counts).

## T8 - Provider conformance suite + capability declaration

Status: completed

### Goal

Prove every adapter behaves identically through the one canonical interface, and make each
adapter's supported feature set explicit so unsupported requests fail loudly instead of
silently degrading.

### Requirements

1. `ProviderAdapter` gains a `capabilities` declaration:
   `{ chat, streaming, tools, json, systemMessages, maxTokens }`.
2. The HTTP layer consults capabilities before dispatch; a request needing an undeclared
   capability returns `400 {error:{code:"unsupported_capability",...}}` with no provider call.
3. Per-adapter truths become explicit and tested: Anthropic folds ALL system messages into
   native `system` + implicit `max_tokens` 1024; OpenAI-compatible retries a stream once
   without `stream_options` on 400; mock echoes.
4. A translation table (trim rules, defaults, system mapping per adapter) is frozen in a
   doc-comment that matches tested behavior.

### Related Architecture

`agent/implementation.md` Part B → Provider adapters; INV-1, INV-5.

### Files

Extends `src/providers/*` + `src/domain/types.ts`. No new endpoints.
New `tests/contract/provider-conformance.test.ts` — one fixture matrix per adapter:
translation, ordering, timeout/abort propagation, error map, usage normalization,
redaction (no keys/prompt text in logs), malformed-response handling. Live tests stay opt-in.

### Acceptance Criteria

- Same canonical request → same canonical shape from mock, OpenAI-compatible (fake server),
  and Anthropic (fake server).
- Unsupported capability → explicit `400`, provider never called.
- Capability declarations in code match the conformance matrix per adapter.
- Live provider tests remain opt-in only.

### Testing Requirements

- New `tests/contract/provider-conformance.test.ts`: one fixture matrix per adapter covering
  translation, message ordering, timeout/abort propagation, error classification
  (429/401/404/5xx), usage normalization, log redaction (no keys/prompt text),
  malformed-response handling. Every cell asserts a named invariant; unfailable cells are
  sharpened or deleted.
- Existing suites stay green (no adapter behavior change for conforming requests).

### Dependencies

None — first open task. De-risks T14's multi-provider paths.

## T9 - Canonical response wiring (admission + stream)

Status: completed

### Goal

Two spellings of one answer must never occupy two cache entries; stream chunks must not
leak markup closers.

### Requirements

1. `normalizeChatContent` before cache admission; `StreamingResponseNormalizer` hold-back
   for straddling markers; usage preserved-or-absent.

### Related Architecture

`agent/implementation.md` Part B → Response normalizer; Data Flow.

### Files

`src/domain/responseNormalizer.ts` wired in `src/api/routes/chat.ts`.

### Acceptance Criteria

- Stored blobs stay canonical; straddling markers never mis-emitted in streams.

### Testing Requirements

- `tests/unit/response-normalizer.test.ts`, `tests/integration/response-normalization.test.ts`.

### Dependencies

T4, T6 (admission + stream paths it normalizes).

## T10 - Embedding + vector-store wiring

Status: completed

### Goal

Paraphrase recall without coupling lookup semantics to a backend.

### Requirements

1. `EmbeddingProvider` (mock/gemini/ollama, 768-d, role-tagged prompt text) +
   `SemanticCacheStore` port: in-memory brute-force cosine or pgvector (migration `001`,
   upsert, HNSW, expiry filter); dim mismatch loud at boot; `SEMANTIC_STORE` typo fails boot.

### Related Architecture

`agent/implementation.md` Part B → Embeddings; Semantic cache; Database/Storage Architecture.

### Files

`src/embeddings/*`, `src/cache/InMemoryVectorStore.ts`, `PgVectorStore.ts`, `semanticFactory.ts`.

### Acceptance Criteria

- Same user text under different system prompts embeds differently; misconfiguration fails
  loud instead of silently never hitting.

### Testing Requirements

- `tests/unit/embeddings.test.ts`, `tests/unit/inmemory-vector.test.ts`, `tests/unit/pgvector-sql.test.ts`, `tests/unit/semantic-config.test.ts`.

### Dependencies

T2 (provider/model identity it filters on).

## T11 - Semantic lookup path

Status: completed

### Goal

Turn paraphrases into $0 hits; exact-before-semantic order.

### Requirements

1. Non-stream only; exact MISS → embed → `findSimilar` → policy gate → HIT/SKIP; headers
   `x-cache:SEMANTIC_HIT` + `x-semantic-similarity`; embed/vector failure → provider path
   with `semantic_errors`, never 5xx.

### Related Architecture

`agent/implementation.md` Part B → Request Flow; Semantic cache; INV-2, INV-6.

### Files

`src/api/routes/chat.ts`, `src/cache/*`, `src/embeddings/*` (non-stream branch of
`POST /v1/chat/completions`).

### Acceptance Criteria

- Paraphrase reuses with similarity header and no provider call; unrelated prompt misses;
  embedder outage still succeeds via provider.

### Testing Requirements

- `tests/integration/semantic-cache.test.ts`.

### Dependencies

T10 (embedding + store), T4 (exact-miss ordering).

## T12 - Reuse policy hardening

Status: completed

### Goal

Retrieval finds CLOSE; policy decides SAFE (banking 99%-FP lesson).

### Requirements

1. Pure `isReusableSemantic` re-checks provider/model/temperature/max_tokens/threshold/
   non-empty with reason codes, defense-in-depth over store SQL filters.

### Related Architecture

`agent/implementation.md` Part B → Reuse policy; INV-6.

### Files

`src/policy/reuse.ts`.

### Acceptance Criteria

- Unsafe candidates skipped with exact reason; misses counted, never served.

### Testing Requirements

- `tests/unit/semantic-reuse.test.ts`.

### Dependencies

T11 (candidates it judges).

Remaining (folded into T16): tenant re-check, system-prompt fingerprint, source/policy
version in policy (today enforced only in store layer).

## T13 - Cache admission + eviction

Status: completed

### Goal

Only safe, valuable answers enter; memory stays bounded.

### Requirements

1. Admit success + non-empty only; TTL on both stores; LRU caps (exact 1000, vector 2000)
   with `recordHit` hooks; dedupe on prompt_hash; malformed exact entries evicted on read;
   double-write failure never fails the request.

### Related Architecture

`agent/implementation.md` Part B → Data Flow; Database/Storage Architecture; INV-8.

### Files

`src/cache/*`, admission logic in `src/api/routes/chat.ts`.

### Acceptance Criteria

- Empty/error responses never stored; expired entries miss; memory bounded under load.

### Testing Requirements

- `tests/unit/inmemory-eviction.test.ts`, `tests/unit/inmemory-vector.test.ts`, `tests/integration/exact-cache.test.ts`.

### Dependencies

T11, T12 (lookup + policy it admits for).

Remaining (→ T16): tenant re-check at admission; explicit system-prompt fingerprint
column/policy.

## T14 - Provider fallback + circuit breaker + retry

Status: completed

### Goal

Keep serving when the primary provider rate-limits or fails: ordered failover with bounded
transient retries and a per-target breaker, exhausting to a clean 502.

### Requirements

1. Ordered chain execution per request; `GatewayError.retryable` (429/5xx/timeout) retried
   up to 2 times with exponential backoff + full jitter; non-retryable fails over immediately.
2. Per-target breaker: opens after N consecutive failures, skips the target for a cooldown,
   half-open probe re-admits; state visible in `/metrics` (`breaker_open`).
3. Chain exhausted → `502` standardized body; serving target reported via `x-provider`,
   failover via `x-fallback:true`; `fallback_count` metric.
4. Fallback answers cached under the serving provider's key only (INV-7); error responses
   never admitted (INV-8).
5. Streaming: failover only before the first token; mid-stream failure closes the stream.

### Related Architecture

`agent/implementation.md` Part B → Provider adapters / HTTP layer; Error Handling; errors
classification in `src/infrastructure/errors.ts`.

### Files

New `src/routing/fallback.ts` (+ breaker state); `src/infrastructure/errors.ts` (verify
retryable flags); `src/api/routes/chat.ts` wiring. No new endpoints; `GET /metrics` gains
`fallback_count`, `breaker_open`.

### Acceptance Criteria

- Kill the primary → automatic healthy answer via fallback with correct headers.
- All targets down → 502, no leaked internals.
- Breaker opens, skips, probes, cools — observable in metrics.
- No mid-SSE provider switch, ever.

### Testing Requirements

- Unit: retry counts + backoff bounds + jitter range; breaker open/skip/probe/cool transitions.
- Integration (`tests/integration/providers-routing.test.ts` extended): primary 500 →
  fallback 200; all down → 502; breaker skip under load; streaming failover boundary;
  fallback cache-key discipline.
- Failure-injection via MockProvider failure modes + fake fetch servers (no live spend).

### Dependencies

T8 (conformance suite proves adapters behave uniformly before routing depends on them).

## T15 - Eval harness + threshold defense + cost metrics

Status: completed

### Goal

Replace the tutorial 0.92 threshold with a data-defended decision and make the savings
visible: a versioned labeled dataset, a deterministic sweep, a written report — only then
may the default move, with the report linked.

### Requirements

1. Versioned labeled dataset: exact duplicates, true paraphrases (must-HIT), near-miss
   distractors — dates/numbers/constraints/topical/near-semantic (must-MISS), cross-domain,
   system-change, tenant-change; minimum counts per family.
2. Sweep 0.60→0.95 through the real store + policy with recorded/mock embeddings; per
   point: precision, recall, FP/FN reuse, safe-reuse rate, P-CHR; per-category breakdown;
   cost table with the FP-penalty × price assumption stated.
3. Report at `evaluation/report.md` (created by this task); chosen optimum + assumption
   written before any default changes.
4. `/metrics` extends: similarity histogram buckets, `tokens_in/out` (reported usage only),
   `estimated_cost_saved` (hits priced against configurable per-model cost; absent usage =
   zeros).

### Related Architecture

`agent/implementation.md` Part B → Reuse policy / Observability; reviewer eval gate
(`agent/review.md` §5).

### Files

New `scripts/eval/*`, new `evaluation/report.md`; metrics extension in
`src/observability/metrics.ts`. No new endpoints. Harness deterministic (seeded, CPU-only,
no live spend in CI).

### Acceptance Criteria

- Report picks a threshold with the FP/FN + $ tradeoff table and states the assumption.
- `SEMANTIC_THRESHOLD` default changes only with the report link.
- Metrics show `estimated_cost_saved` moving with hit rate.
- Harness is deterministic, CPU-only, no live spend in CI.

### Testing Requirements

- Determinism check: two harness runs produce identical outputs (seeded PRNG).
- Metrics unit tests: histogram buckets populate; savings track hits; absent usage
  contributes zeros.
- Dataset validation: every fixture carries a label + family; minimum counts enforced by
  the script.

### Dependencies

T16 (evaluates the final reuse semantics).

## T16 - Policy/admission depth (tenant + system fingerprint + policy version)

Status: completed

### Goal

Make reuse safety independent of any single layer: the policy itself re-checks tenant
identity and system-prompt fingerprint (defense in depth over SQL filters), and
version-stamps entries so eval-driven policy changes never silently reinterpret old answers.

### Requirements

1. `isReusableSemantic` adds `tenant-mismatch`, `system-fingerprint-mismatch`,
   `policy-version-mismatch` reasons; stays pure (no I/O).
2. Semantic entries gain `system_fingerprint` = sha256(concat of system-message contents)
   and `policy_version` stamped at admission; NULL fingerprint skips the check (legacy rows),
   recorded in the eval report.
3. Both stores + admission path persist and return the new fields; migration
   `db/migrations/002_semantic_system_fp.sql` (nullable columns, no backfill).
4. Policy version constant bumps invalidate old entries lazily on read.

### Related Architecture

`agent/implementation.md` Part B → Reuse policy / Semantic cache; INV-6, INV-8.

### Files

`src/policy/reuse.ts`, `src/cache/SemanticCacheStore.ts`, `PgVectorStore.ts`,
`InMemoryVectorStore.ts`, optional `db/migrations/002_semantic_system_fp.sql`;
extend `tests/unit/semantic-reuse.test.ts` + `tests/integration/semantic-cache.test.ts`.
No new endpoints.

### Acceptance Criteria

- Every unsafe variant → `reusable:false` with the exact reason code.
- Same user text under a changed system prompt never reuses (integration-proven).
- Entries admitted under an older policy version are rejected on read.
- Policy remains pure and versioned for eval reproducibility.

### Testing Requirements

- Unit (`tests/unit/semantic-reuse.test.ts` extended): full reason matrix incl.
  NULL-fingerprint skip + version mismatch.
- SQL contract (`tests/unit/pgvector-sql.test.ts`): new columns in SELECT/INSERT/UPSERT clauses.
- Integration (`tests/integration/semantic-cache.test.ts`): system-prompt change → no reuse;
  tenant re-check with a store-filter-bypass simulation.

### Dependencies

T14 (lands before eval so T15 defends final reuse semantics).

---

## T17 - Exact cache must not admit empty responses (INV-8 gap)

Status: completed

### Goal

Close the live-proven INV-8 gap: empty provider responses enter the exact cache and are served as HITs, while the semantic path already refuses them.

### Requirements

1. Gate the exact-cache write on non-empty normalized content (`trim() !== ""`), mirroring the semantic admission guard.
2. An empty upstream reply is still served to the caller once (200) but never stored; the next identical request re-calls the provider.

### Related Architecture

`agent/implementation.md` Part B → Response normalizer / Exact cache; INV-8.

### Files

`src/api/routes/chat.ts` (admission block); regression test in `tests/cache-eval.test.ts` or `tests/integration/exact-cache.test.ts`.

### Acceptance Criteria

- Provider returns empty content → 200 once, repeat is MISS (not HIT), provider called twice.
- Non-empty admission behavior unchanged (existing suites green).

### Testing Requirements

- New regression test: empty-content admission attempt → MISS on repeat + 2 provider calls.
- Full offline suite + typecheck green.

### Dependencies

None — correctness bugfix, blocks shipping.

---

## T18 - Live re-verification after quota reset (semantic + TTL legs)

Status: pending

### Goal

Prove the semantic path against a real upstream (not just doubles): paraphrase HIT with measured similarity, TTL expiry on both stores.

### Requirements

1. Restart eval gateway on :3001 (`PROVIDER` with budget, `EMBEDDING_PROVIDER=gemini`, `SEMANTIC_THRESHOLD=0.80`).
2. Semantic leg: seed → paraphrase SEMANTIC_HIT (record similarity) → temp drift MISS → unrelated MISS → other-tenant MISS.
3. Restart with `CACHE_TTL_S=3` + `SEMANTIC_TTL_S=3`; TTL leg: HIT→expiry→MISS on both stores.
4. Respect free-tier quotas (pace calls ≥15s; stop on 429, resume after reset).

### Related Architecture

`agent/implementation.md` Part B → Semantic cache / Request Flow; T15 live-leg criteria.

### Files

No repo changes. Temp runner in system Temp dir (deleted after); gateway stopped after.

### Acceptance Criteria

- B2 SEMANTIC_HIT with recorded similarity (expect ~0.96 class); B2b/B3/B4 all MISS.
- C1/C2 HIT then C3/C4 MISS after expiry.
- Evidence (statuses/headers/similarities) reported to owner, no commit.

### Testing Requirements

- Live legs only; offline suite untouched and still green.

### Dependencies

T17 (empty-admission fix lands first so live legs measure correct behavior); external: upstream quota reset.

---

## T19 - Push local commits to remote

Status: pending

### Goal

Remote holds exactly what is verified locally; no work ships from a local-only tree.

### Requirements

1. Verify remote state (`git fetch`, compare `main` vs origin).
2. Push committed work only (no uncommitted changes ride along).
3. Confirm remote HEAD matches local after push.

### Related Architecture

None (release hygiene).

### Files

No repo changes (git operations only).

### Acceptance Criteria

- `git status` clean; origin/main equals local HEAD; proof shown (`git log -1 --stat` + status).

### Testing Requirements

- None beyond the already-green suite on the pushed commit.

### Dependencies

None — do any time; do before any deploy.

---

## T20 - README + .env.example + LICENSE

Status: pending

### Goal

A stranger can run the gateway without reading source: what it is, how to start it, what to configure, under what license.

### Requirements

1. `README.md`: goal, quickstart (`npm install/dev`), endpoints table, env overview (link `.env.example`), cache behavior summary, known limits pointer.
2. `.env.example`: every variable from `src/infrastructure/config.ts` with defaults commented, zero secrets.
3. `LICENSE`: owner-chosen license file.

### Related Architecture

`agent/implementation.md` Part A (Goal/Problem/Features); Part B → Interfaces/Contracts.

### Files

New `README.md`, `.env.example`, `LICENSE` at repo root. No code changes.

### Acceptance Criteria

- Fresh checkout + `.env.example` copied to `.env` + `npm run dev` serves `/health` (reviewer verifies by following README literally).
- Every config key appears in `.env.example`; no real secrets anywhere in the three files.

### Testing Requirements

- Docs-only; reviewer runs the README quickstart verbatim.

### Dependencies

None.

---

## T21 - Dockerfile + CI workflow

Status: pending

### Goal

Reproducible image and a CI gate so `main` never goes red silently.

### Requirements

1. `Dockerfile`: Node build (`npm ci`, `tsc` build) + minimal runtime (`node dist/`), non-root user, `PORT` honored, healthcheck on `/health`.
2. `.github/workflows/ci.yml`: on push/PR — `npm ci`, `npm run typecheck`, offline `npm test` (no keys in env).
3. Optional `.dockerignore` (node_modules, .env, logs).

### Related Architecture

`agent/implementation.md` Part B → Composition root; runbook commands.

### Files

New `Dockerfile`, `.github/workflows/ci.yml` (+ `.dockerignore`) at root. No app-code changes.

### Acceptance Criteria

- `docker build` succeeds; container boots and `/health` returns ok.
- CI passes on the commit (reviewer checks the workflow run, not a local claim).

### Testing Requirements

- CI run green; image boot + `/health` verified.

### Dependencies

T20 (README documents the Docker/CI flow).

---

## T22 - Auth posture + documented shipping limits

Status: superseded by T23–T27

### Goal

No accidental open gateway. Token mode is implemented by T23–T27; this task is history only.

### Requirements

1. Owner chose Token mode: two lanes on one chat endpoint (gateway key = registered lane with full cache plus own usage; provider key = anonymous try-out lane with cache bypass).
2. No further work lands here — implement T23–T27 instead.

### Related Architecture

`agent/implementation.md` Part B → Security Considerations; Interfaces/Contracts.

### Files

None. History only — see T23–T27 for the Token mode file scope.

### Acceptance Criteria

- Superseded: acceptance is tracked on T23–T27.

### Testing Requirements

- None here; testing is tracked on T23–T27.

### Dependencies

None. T23–T27 implement the chosen mode.

---

## T23 - Auth seed config + migration

Status: completed

### Goal

Keys and provider credentials have a home, dev boots with zero setup, stored provider keys never sit in plaintext.

### Requirements

1. Add `db/migrations/002_api_keys.sql` with `api_keys` and `provider_credentials` tables.
2. Extend `loadConfig` with `GATEWAY_API_KEYS` seed (`tenant:provider:name:key` entries, bad entry fails boot) and `CRED_ENC_KEY` (missing key with `DATABASE_URL` set fails boot).

### Related Architecture

`agent/implementation.md` Part B → Auth; Composition root.

### Files

`src/infrastructure/config.ts`, `db/migrations/002_api_keys.sql`.

### Acceptance Criteria

- Empty seed parses to no keys; single and multiple entries parse with whitespace trimmed and stray commas skipped.
- Keys containing colons survive; entries with fewer than 4 parts, empty parts, or unknown providers fail boot.
- `CRED_ENC_KEY` passes through; `DATABASE_URL` without it fails boot.
- Migration creates both auth tables with `key_hash UNIQUE` and `(tenant_id, provider)` primary key.

### Testing Requirements

- `tests/unit/auth-config.test.ts` (config parsing + migration content assertions).

### Dependencies

None.

---

## T24 - Key and credential ports

Status: pending

### Goal

HTTP and guard code depend on ports, not SQL; behavior is locked while storage stays an implementation detail.

### Requirements

1. Define `ApiKeyStore` (`verify`, `create`, `list`, `revoke`, `rotate`) with sha256-hash storage, `lg_` prefixed keys, plaintext shown once.
2. Define `CredentialStore` (`save`, `get`, `remove`) with encrypt-on-write and decrypt-on-read; provider keys never returned.
3. Contract tests pin the semantics.

### Related Architecture

`agent/implementation.md` Part B → Auth; INV-9.

### Files

`src/auth/ApiKeyStore.ts`, `src/auth/CredentialStore.ts` plus contract tests.

### Acceptance Criteria

- `verify` accepts a valid key and binds tenant plus provider; revoked or expired keys fail.
- `create` returns plaintext once and stores only the hash; `rotate` invalidates the old key.
- `save`/`get` round-trips the provider key encrypted; stored rows never hold plaintext.

### Testing Requirements

- Contract tests: verify/create/list/revoke/rotate lifecycle; encrypt round-trip; revoked and expired rejection.

### Dependencies

T23 (tables and seed config it builds on).

---

## T25 - Lane guard

Status: pending

### Goal

One guard owns lane logic and the auth error vocabulary; the pick runs before validation, provider, and cache.

### Requirements

1. New `laneGuard` preHandler: gateway key present goes registered (verify, attach `request.auth` with tenant and provider); else provider-key header present goes anonymous (attach header key, no tenant); else 401 with register hint.
2. Error map: 401 missing everything or bad gateway key; 403 revoked, expired, or provider mismatch; 503 store down. No key material in logs.

### Related Architecture

`agent/implementation.md` Part B → Auth; Error Handling; INV-9.

### Files

`src/auth/laneGuard.ts`.

### Acceptance Criteria

- No key of either kind → 401 with register hint.
- Bad gateway key → 401; revoked, expired, or provider mismatch → 403; store down → 503 `auth_unavailable`.
- Guard runs before validation, provider, and cache (no spend on auth failure).

### Testing Requirements

- Contract tests for the full lane matrix: 401 no-key, 401 bad key, 403 revoked/expired/mismatch, 503 store down, registered attach, anonymous attach.

### Dependencies

T24 (stores the guard verifies against).

---

## T26 - Chat with two lanes

Status: pending

### Goal

Try-out traffic flows without leaking server keys or cache entries; registered users get the full savings pipeline with attributed numbers.

### Requirements

1. Register `laneGuard` on chat. Registered lane: resolve upstream key from stored credential, run the full cache pipeline, record per-tenant usage.
2. Anonymous lane: resolve upstream key from the header only, bypass caches with `x-cache: BYPASS`, count global counters only.
3. Reply carries `x-lane` (`registered` | `anonymous`) plus `x-key-id` on the registered lane; `x-tenant-id` header always ignored.

### Related Architecture

`agent/implementation.md` Part B → Auth; Request Flow; INV-7, INV-8, INV-9.

### Files

`src/api/routes/chat.ts`, `src/server.ts`.

### Acceptance Criteria

- Registered request serves exact plus semantic hits and records per-tenant usage; serving provider must equal key provider else 403.
- Anonymous request bypasses cache, uses only the header key (never server keys), and counts global counters only.
- No key → 401 before validation, provider, or cache; evidence headers present on every validated reply.

### Testing Requirements

- Integration: registered hit path with `x-lane`/`x-key-id`; anonymous bypass with header key; 401 no-key; 403 provider mismatch.

### Dependencies

T25 (lane contract the chat route reuses).

---

## T27 - Register and own usage

Status: pending

### Goal

One call turns try-out users into settled users; each user sees only its own numbers.

### Requirements

1. `POST /v1/register` (open): validate provider, store the encrypted provider key, issue a gateway key, return it once.
2. `GET /v1/usage` (gateway key): return the caller tenant slice only — requests, exact hits, semantic hits, misses, hit rate, avoided calls, avg latency.
3. `metrics` gains `auth_rejects_total`.

### Related Architecture

`agent/implementation.md` Part B → Auth; Observability.

### Files

`src/api/routes/register.ts`, `src/api/routes/usage.ts`, `src/observability/metrics.ts`, `src/server.ts`.

### Acceptance Criteria

- `POST /v1/register` with `{ name, provider, provider_key }` → 201 `{ tenant_id, provider, key (once), key_prefix }`; 400 on validation or unknown provider; 503 when store down.
- `GET /v1/usage` returns only the caller tenant slice; 401 bad key; 403 revoked or expired.
- No key material in logs, metrics, health, or usage bodies.

### Testing Requirements

- Contract: register 201 plus key-once property; usage tenant isolation; 400/401/403/503 matrix; `auth_rejects_total` increments.

### Dependencies

T24 (stores), T25 (guard on usage).

---

# Runbook (run, configure, observe)

> Behavior contracts live in `agent/implementation.md` Part B; scope/success in Part A.

## Commands

```bash
npm install            # once
npm run dev            # dev server (tsx, hot start) — http://localhost:3000
npm run build          # tsc -> dist/
npm start              # prod server from dist/ (run build first)
npm test               # vitest unit + integration (offline; live test auto-runs ONLY if GEMINI_API_KEY is set)
npm run test:live      # same live Gemini test, run directly (needs GEMINI_API_KEY)
npm run typecheck      # tsc --noEmit -p tsconfig.check.json
```

## Endpoints

| Route | Method | Notes |
| --- | --- | --- |
| `/v1/chat/completions` | POST | Gateway key (`Authorization: Bearer`) or provider key (`x-provider-key`). Invalid → `400`, never calls provider. Reply carries `x-lane` plus `x-key-id` on the registered lane. |
| `/v1/register` | POST | Open. Body `{ name, provider, provider_key }` → `201` with gateway key shown once. |
| `/v1/usage` | GET | Gateway key. Caller tenant slice only. |
| `/health` | GET | Liveness (public). |
| `/metrics` | GET | JSON snapshot (keys below). |
| `/providers` | GET | Configured provider list. |
| `/` | GET | Playground UI (static, same-origin). CORS allowed on the four API routes for the metrics card. |

## Environment variables (parsed only in `src/infrastructure/config.ts`)

Core:

- `PORT` (default `3000`)
- `PROVIDER` — `mock | gemini | ollama | openai | anthropic | openrouter` (default `mock`)
- `UPSTREAM_TIMEOUT_MS` (default `25000`)

Exact cache:

- `CACHE_ENABLED` (default `true`)
- `REDIS_URL` (empty → in-memory LRU fallback)
- `CACHE_TTL_S` (default `3600`)

Semantic cache:

- `SEMANTIC_ENABLED` (default `true`)
- `SEMANTIC_THRESHOLD` (default `0.92`; eval-gated — see `agent/review.md` §5)
- `SEMANTIC_TOP_K` (default `3`), `SEMANTIC_TTL_S` (default `3600`)
- `SEMANTIC_STORE` — `memory | pgvector` (default `memory`)
- `EMBEDDING_PROVIDER` — `mock | gemini | ollama` (default `mock`), `EMBEDDING_MODEL`
- `DATABASE_URL` (required for `SEMANTIC_STORE=pgvector`; schema applied automatically at
  boot from `db/migrations/001_semantic_cache.sql`)
- `SAVED_USD_PER_1K_TOKENS` (default `0` = savings off; set to price reused tokens,
  e.g. `0.002` — drives `estimated_cost_saved`)

Auth:

- `GATEWAY_API_KEYS` (empty → no seed keys; entries `tenant:provider:name:key`, bad entry fails boot)
- `CRED_ENC_KEY` (empty in dev; required when `DATABASE_URL` is set)

Per-provider (only the selected `PROVIDER` needs its key; routing needs any provider whose
model prefix a client may send):

- `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.6-flash`), `GEMINI_BASE_URL`
- `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`), `OLLAMA_MODEL` (default `llama3.1:8b`)
- `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`), `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-4`), `ANTHROPIC_BASE_URL`
- `OPEN_ROUTER_KEY`, `OPENROUTER_MODEL`
  (default `nvidia/nemotron-3-super-120b-a12b:free`), `OPENROUTER_BASE_URL`
  (default `https://openrouter.ai/api/v1`). No key is required for `:free` models;
  models ending `:free` or prefixed `openrouter/` route to openrouter automatically.

## `GET /metrics` keys (in-memory, process lifetime)

Counters: `requests_total`, `exact_hits`, `exact_misses`, `singleflight_leaders`,
`singleflight_coalesced`, `provider_requests`, `provider_errors`, `cache_lookup_failed`,
`cache_write_failed`, `semantic_hits`, `semantic_misses`, `semantic_errors`,
`fallback_count`, `breaker_open` (gauge: breakers open right now),
`tokens_in`, `tokens_out`, `estimated_cost_saved` (needs `SAVED_USD_PER_1K_TOKENS`),
`semantic_hist_lt_090`, `semantic_hist_090_092`, `semantic_hist_092_095`,
`semantic_hist_gte_095`, `auth_rejects_total`.

> Token + cost accounting is live (histogram, token + savings counters above);
> the T15 threshold decision itself stays eval-gated (see T15 above).

Derived: `semantic_lookups`, `avg_semantic_score`, `cache_lookups`, `avg_cache_lookup_ms`,
`provider_latency_ms_total`, `avg_provider_ms`, `hit_rate`, `provider_calls_avoided`.

## Health triage

- Lane pick runs before validation, provider, and cache. No lane → `401` with register hint, no spend. Registered: serving provider must equal key provider else `403`. Anonymous: `x-provider-key` required, cache `BYPASS`, upstream uses the header key only.
- `x-tenant-id` header is always ignored — tenant comes from the verified gateway key.

- Semantic entries stay scoped per tenant; exact cache keys are per provider+request.
  Policy-level tenant re-checks are open work (T16).
- Cache/Redis or pgvector down → requests still succeed (MISS + `cache_lookup_failed` /
  `semantic_errors` climb); never a 5xx from the cache layer.
- Provider down/timeout → `429|502|504` per error mapping; SDK internals never leak.
- `PROVIDER`/`EMBEDDING_PROVIDER`/`SEMANTIC_STORE` typos fail loud at startup.

## Tests + live spend

`npm test` is offline by design EXCEPT `tests/integration/gemini-live.test.ts`, which
auto-runs whenever `GEMINI_API_KEY` is present in the environment (it uses
`describe.skipIf`). For deterministic CI, keep the key out of the test env.
`tests/integration/openrouter-live.test.ts` follows the same opt-in pattern via
`OPEN_ROUTER_KEY` and hits only `:free` models ($0 tier, 3 requests per run).
`tests/contract/provider-conformance.test.ts` (T8) is fully offline.

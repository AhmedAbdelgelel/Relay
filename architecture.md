# architecture.md — Day 1: Gateway Core (no cache)

> Status: Day-1 only. Evolves weekly per build plan §6. Full pipeline (normalize -> exact -> semantic -> policy -> router -> provider -> admission -> observability) is the target, NOT today's build.

## 1. Data flow (Day 1)

```text
Client
  |
  v
[HTTP API: POST /v1/chat/completions]
  |
  v
[Validate OpenAI subset]
  |-- invalid -> 400 (never call provider)
  v
[ProviderAdapter.chat / chatStream]
  |
  v
[LLM Provider (Mock default, OpenAI-compatible HTTP)]
  |
  v
[Response Processor: normalize + SSE framing]
  |
  v
Client (+ x-request-id, JSON logs)
```

Cross-cutting: `AbortController` timeout + client-abort wired through every layer. No retry on Day 1 (see ADR-002).

## 2. Components & boundaries

```text
src/
  server.ts                   # composition root only: config -> factory -> routes. Only place that chooses.
  api/routes/chat.ts        # HTTP only: parse, validate, headers, SSE. No provider logic.
  domain/types.ts           # ChatRequest, ChatResponse, GatewayError. No I/O.
  providers/
    ProviderAdapter.ts      # interface (contract below)
    MockProvider.ts         # deterministic, delay-injectable for timeout tests
    OpenAICompatibleProvider.ts # fetch + AbortSignal, SSE parse. Only place with fetch. Covers gemini/ollama/openai.
    factory.ts              # CHOOSING: createProviderFromEnv(). Only place with `new` on providers.
  infrastructure/
    config.ts               # STANDARDIZATION: sole reader of process.env
    logger.ts               # pino-style JSON log: request_id, latency_ms, provider, status
    errors.ts               # mapProviderError() -> {status, code, retryable}
```

Deviations from early draft: `OpenAIProvider.ts` renamed to `OpenAICompatibleProvider.ts` (one class covers all OpenAI-compatible backends); `http.ts` split into `server.ts` (composition root) + `api/routes/chat.ts`; added `factory.ts` + `config.ts` to enforce CHOOSING/STANDARDIZATION. No behavior change.

Rule: `api` may call `providers` via interface only. `domain` imports nothing. No `cache/embeddings/policy` directories yet — create them Week 2+ to prevent premature abstraction.

## 3. Interfaces (frozen for Day 1)

### 3.1 Request (OpenAI subset)
```ts
type ChatRequest = {
  model: string;                          // e.g. "gpt-4o-mini", required
  messages: { role: "system"|"user"|"assistant"; content: string }[]; // >=1, non-empty content
  temperature?: number;                   // default 1.0, 0..2
  max_tokens?: number;                    // >0 if present
  stream?: boolean;                       // default false
};
```

### 3.2 Provider contract
```ts
interface ChatResponse { id: string; model: string; content: string; usage?: { prompt_tokens: number; completion_tokens: number }; }
interface ProviderAdapter {
  name: string;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<string>; // yields content deltas
}
```

### 3.3 HTTP contract
- `POST /v1/chat/completions` -> `200` JSON `{id, model, choices:[{message:{role,content}, finish_reason}], usage?}`
- `stream:true` -> `200 Content-Type: text/event-stream`, frames `data: {...}\n\n`, terminal `data: [DONE]`
- Headers in/out: `x-request-id: uuid` (generate if absent), `x-provider`, `x-latency-ms` (debug)
- Errors: `{error:{code: string, message: string, request_id: string}}` with `400|429|502|504`

## 4. Failure behavior (invariants)

| Case | Behavior |
|---|---|
| Validation fail | `400 invalid_request`, provider NOT called |
| Upstream timeout (default 25s, test 2s) | abort fetch, `504 gateway_timeout` |
| Upstream 429 | `429 provider_rate_limited`, `retryable:true` |
| Upstream 5xx / network | `502 provider_error`, no stack leak |
| Client disconnect mid-stream | `AbortController.abort()`, upstream fetch cancelled, no orphan |
| Unknown model | Deferred to Router (Week 4). Day 1 only checks non-empty `model`; remote provider is source of truth and its 404 maps to `502 provider_not_found`. |

Explicit non-retry Day 1: observe timeouts first, add retry/backoff Week 5 with policy. Documented to avoid hiding failures.

## 5. Stack & config (ADR-001/002/003)
- **TS + Node 20 + Fastify + Zod + Vitest.** Why: fast SSE + validation + easy mock; matches build plan `Node/Go` option. Swappable to Go later — interface isolates it.
- Providers (all OpenAI-compatible, no interface change — see ADR-003):
  - `mock` (default, no setup): deterministic, delay-injectable for timeout/abort tests
  - `gemini` (primary free remote): `https://generativelanguage.googleapis.com/v1beta/openai/`, e.g. `gemini-3.6-flash`. Free-tier key from AI Studio. Use for all Day-1 manual + eval traffic.
  - `ollama` (fallback local, unlimited): `http://localhost:11434/v1`, e.g. `llama3.1:8b`. Use for stampede/load tests to avoid burning Gemini quota.
  - `openai` (paid, later): standard `https://api.openai.com/v1`
- Config via env: `PORT, PROVIDER=(mock|gemini|ollama|openai), GEMINI_API_KEY, GEMINI_MODEL, OLLAMA_BASE_URL, OLLAMA_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL, UPSTREAM_TIMEOUT_MS=25000, LOG_LEVEL`.
- Default `PROVIDER=mock` so tests run with zero setup. Manual experiments use `PROVIDER=gemini` once `GEMINI_API_KEY` is set. Note: Gemini free tier is rate-limited — keep concurrency tests on `mock`/`ollama`.

## 6. Observability (minimal)
JSON log per request: `request_id, method, path, model, provider, status, latency_ms, stream, error_code?`. No Prometheus yet (Week 6).

## 7. Testing strategy (Day-1 DoD)
- `tests/contract/chat.contract.test.ts`: happy-path + invalid-body schema tests
- `tests/integration/provider.test.ts`: Mock delay > timeout -> `504`; Mock 429/500 -> normalized; abort mid-stream cancels upstream (spy on AbortSignal)
- Manual: `curl` non-stream + `curl -N` stream
- Typecheck + lint must pass. No load test yet (Week 8).

## 8. Learning experiments (must run before coding)
1. `docs/experiments/day01-provider-timeout.md`: 20-line `fetch + AbortController` script, kill/slow mock, observe abort. Proves you understand timeout vs cancellation.
2. SSE framing experiment: `curl -N` against Mock stream, disconnect mid-way, confirm upstream abort log.

## 9. What changes next (not now)
- Day 2: `domain/normalize.ts` + canonical JSON + hash (no Redis).
- Day 3-4: `CacheRepository` (get/set/delete/exists) behind interface, Redis only in `infrastructure`.
- If Day-1 proof (§product.md §6) fails, do NOT proceed to Day 2.

## 10. ADRs
- ADR-001: modular monolith, TS+Fastify (see `docs/decisions/`)
- ADR-002: OpenAI-compatible subset, no retry/cache Day 1
- ADR-003: free providers — Gemini Flash primary + Ollama local fallback (no paid OpenAI needed)

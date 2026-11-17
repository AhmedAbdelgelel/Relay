# Relay — two-layer cache gateway for LLM APIs

[![CI](https://github.com/AhmedAbdelgelel/Relay/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmedAbdelgelel/Relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests: 374 core + 112 UI](https://img.shields.io/badge/tests-374%20core%20%2B%20112%20UI-brightgreen)](tests/)
[![Runtime: Node 24](https://img.shields.io/badge/runtime-Node%2024-339933)](Dockerfile)

Relay is an OpenAI-compatible gateway with **two cache layers** in front of your LLM providers. It answers repeated requests from memory, answers safe near-duplicates from a semantic layer, and only calls the provider on a real miss. Every reply carries headers that say which layer answered and why.

The point is simple: the same prompt should not be paid for twice, and a similar-looking prompt should not silently return the wrong answer.

## How the two layers work

```
client request
  → auth lane (registered lg_… key, or anonymous try-out)
  → validate request (reject unsupported fields before spending anything)
  → Layer 1 — exact cache: same tenant + provider + canonical request?
        HIT → return cached answer, zero provider calls
  → Layer 2 — semantic cache: safe semantic match for this tenant/provider/model?
        SEMANTIC_HIT → return cached answer, zero provider calls
  → MISS → provider call → normalize → store in both layers → reply
```

### Layer 1 — exact cache

- Key: `llm:exact:v2:<tenant>:<provider>:<sha256(canonical request)>`.
- The tenant comes from the verified gateway key, never from a client header, so two tenants cannot read each other's exact entries.
- Identity includes `model`, `messages`, `temperature`, `max_tokens`, `top_p` and `stop`.
- Bounded in-memory LRU (or Redis when configured) with a TTL; hits return in milliseconds and make no provider call.
- Concurrent identical misses use single-flight: 50 requests produce **one** provider call; the other 49 share the answer.

### Layer 2 — semantic cache

- Request text is embedded, then the nearest stored answers for the same tenant/provider/model are retrieved.
- A hit is served **only if** the similarity clears `SEMANTIC_THRESHOLD` **and** the reuse-policy gate passes: tenant, provider, model, temperature, `max_tokens`, system-prompt fingerprint and policy version must all match.
- Requests that set `top_p` or `stop` skip the semantic layer (the stored row cannot prove those sampling settings match); the exact layer still caches them.
- Only successful, non-empty normalized answers are admitted. Provider errors, empty answers and streams are never cached.
- Default threshold is `0.95`: measured to serve duplicate/formatting variants safely. Lower values trade safety for paraphrase hits; see the policy section below.

### Failure behavior

If Redis, the vector store or the embedder is unavailable, the layer degrades to `MISS` and the request still reaches the provider — a cache outage never turns into a 5xx. Anonymous try-out requests always bypass both caches.

## Providers

Relay speaks the OpenAI Chat Completions shape and supports:

| Provider | Notes |
|---|---|
| **OpenCode Go** | Default model **`deepseek-v4.1-flash`** (Go subscription). OpenAI-compatible with a User-Agent and stable `x-opencode-session` header. |
| OpenAI | `gpt-*` models |
| Anthropic | `claude-*` models |
| Google Gemini | `gemini-*` models |
| Ollama | local models (`llama*`, `nomic*`) |
| OpenRouter | `openrouter/*` and `:free` models |
| Mock | zero-setup in-process provider for tests and benchmarks |

Model-prefix routing is automatic; a provider-specific model id never fails over to a different vendor.

## Quickstart

```bash
npm install
npm run dev        # mock provider, http://localhost:3000, zero keys
```

Run against your own OpenCode Go key (the key is only read from the environment — it is never in the repo):

```bash
# .env (git-ignored)
PROVIDER=opencode
OPENCODE_API_KEY=oc_...your-key...
OPENCODE_MODEL=deepseek-v4.1-flash

npm run dev
```

Register once, then chat with the issued key:

```bash
curl -s -X POST localhost:3000/v1/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","provider":"opencode","provider_key":"<your OpenCode key>"}'
# -> {"tenant_id":"…","provider":"opencode","key":"lg_…","key_prefix":"…"}

curl -s -X POST localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer lg_…" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"What is a cache hit?"}]}' \
  -D - -o /dev/null | grep -i 'x-cache'
# first call: x-cache: MISS; repeat the same body: x-cache: HIT
```

Docker: `docker compose up --build` starts gateway (`:3000`), control plane (`:3001`) and Redis. The OpenCode Go → DeepSeek V4.1 Flash path was also exercised live through Relay — see the live cache table below.

> DeepSeek V4.1 Flash is a reasoning model: if `max_tokens` is too small, the budget can be consumed by reasoning tokens and the visible content may be empty (empty answers are never cached). Give it a normal token budget when testing large prompts.

## Large-context cache benchmark

Reproduce with:

```bash
npm run bench:large-context
```

The benchmark boots the real gateway on a loopback socket with the mock provider (2 ms) and a deterministic test embedder, then measures the cache path at 8–256 KB request bodies. It is a **cache-layer measurement, not real LLM latency**: HIT costs are gateway + cache serialization; MISS costs include the mock provider.

| Context | Exact MISS p50 / p95 | Exact HIT p50 / p95 | Semantic HIT p50 / p95 | Provider calls on hits |
|---:|---:|---:|---:|---:|
| 8 KB | 30.7 / 64.3 ms | 14.8 / 17.2 ms | 15.6 / 17.2 ms | 0 |
| 32 KB | 30.3 / 32.4 ms | 15.9 / 28.3 ms | 15.4 / 16.2 ms | 0 |
| 64 KB | 30.7 / 32.0 ms | 15.3 / 16.9 ms | 15.3 / 16.7 ms | 0 |
| 128 KB | 30.6 / 31.7 ms | 15.1 / 17.1 ms | 15.2 / 17.2 ms | 0 |
| 256 KB | 29.9 / 31.2 ms | 14.9 / 18.2 ms | 14.9 / 17.9 ms | 0 |

Each row: 8 exact-miss requests, 25 exact-HIT repeats and 25 semantic-HIT repeats; the p50/p95 are client-observed loopback RTTs. The important result is that **both hit layers stay flat as context grows** — cache work does not scale with prompt size — while misses carry the one provider call. Run details and the machine configuration are printed as `BENCH_JSON`.

For a wider concurrency/mixed-traffic run, use `npm run bench:perf` (1,000 requests per scenario, 5 repeats, concurrency 1/10/50/100).

### Live OpenCode Go + DeepSeek V4.1 Flash check

A real gateway was run with `PROVIDER=opencode`, `OPENCODE_MODEL=deepseek-v4.1-flash`, exact cache enabled, and a 512 KB body limit. Each prompt was sent twice: the first request reached OpenCode, the repeat was served locally. No key is stored in the repository.

| Context | First request (`MISS`) | Repeat (`HIT`) | Provider prompt tokens | Provider calls |
|---:|---:|---:|---:|---:|
| 8 KB | 8.13 s (provider) | 7.1 ms | 1,679 | 1 |
| 32 KB | 6.81 s (provider) | 7.0 ms | 6,512 | 1 |
| 64 KB | 7.87 s (provider) | 7.1 ms | 12,965 | 1 |

All six requests returned `200` and `x-provider: opencode`; `/metrics` reported `exact_hits=3`, `exact_misses=3`, `provider_requests=3`, `provider_calls_avoided=3`. The exact-cache layer kept the repeat latency flat (~7 ms) even at 64 KB and with a real remote provider. These are single-run numbers on the current network, not a stable latency benchmark — use the hermetic table above for reproducibility.

## Supported API surface

Relay deliberately implements a **subset** of the OpenAI Chat Completions API. Fields outside this table are rejected with a named `400` before any provider or cache work — never silently dropped.

| Field | Type | Notes |
|---|---|---|
| `model` | string | Required; model prefix selects provider |
| `messages` | array `{role: system\|user\|assistant, content}` | Required |
| `temperature` | 0–2, default 1.0 | Part of cache identity and policy |
| `max_tokens` | positive integer | Part of cache identity and policy |
| `stream` | boolean | SSE; bypasses both caches |
| `top_p` | 0–1 | Forwarded; exact-cache identity; semantic skipped |
| `stop` | string or 1–4 strings | Forwarded; exact-cache identity; semantic skipped |

All other fields (`tools`, `tool_choice`, `response_format`, `n`, `logprobs`, penalties, `seed`, …) return `400 invalid_request` naming the field. Request bodies are capped at 512 KB.

## Caching policy summary

| Decision | Policy |
|---|---|
| Exact repeat | Same verified tenant + provider + canonical request → `HIT` |
| Semantic reuse | Similarity ≥ threshold **and** tenant/provider/model/temperature/max_tokens/system fingerprint/policy version match |
| Sampling fields | `top_p`/`stop` set → semantic skipped, exact still safe |
| Admission | Non-empty normalized success only; never errors/empty/streams |
| Cross-tenant | Never for exact or semantic layers |
| Cache failure | Degrade to `MISS`; never a 5xx |
| Default threshold | `0.95` (safe duplicate/near-duplicate reuse) |

## Tests

```bash
npm test                    # offline suite; no provider calls, no keys needed
npm run typecheck
npm run bench               # cache correctness/accounting (44/44 assertions)
npm run bench:large-context # large-context cache table above
npm run bench:perf          # concurrency/mixed-traffic performance benchmark
cd web && npm test && npm run build
```

The suite covers exact/semantic cache behavior, tenant isolation, the request schema, provider adapters, security/secret redaction, malformed providers, cache outages, timeouts, retries, single-flight, and the Next.js control plane (112 UI tests).

## Configuration (highlights)

`.env.example` documents every variable. The essentials:

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDER` | `mock` | `mock`, `opencode`, `openai`, `anthropic`, `gemini`, `ollama`, `openrouter` |
| `OPENCODE_API_KEY` | — | OpenCode Go API key (never commit it) |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/go/openai/v1` | OpenCode inference endpoint |
| `OPENCODE_MODEL` | `deepseek-v4.1-flash` | Default OpenCode Go model |
| `CACHE_ENABLED` / `CACHE_TTL_S` | `true` / `3600` | Exact-cache switch and TTL |
| `REDIS_URL` | — | Use Redis for the exact cache instead of in-memory LRU |
| `SEMANTIC_ENABLED` / `SEMANTIC_THRESHOLD` | `true` / `0.95` | Semantic layer switch and cutoff |
| `SEMANTIC_STORE` / `DATABASE_URL` | `memory` / — | `pgvector` for a persistent semantic store |
| `GATEWAY_API_KEYS` | — | Optional dev seed keys (`tenant:provider:name:key`) |
| `CRED_ENC_KEY` | — | Encryption key for stored provider credentials (required with `DATABASE_URL`) |

## Limits and security

- No rate limits/quotas yet; put Relay behind an authenticated edge before exposing it publicly.
- Exact-cache entries are bounded by count (1,000 in memory; 2,000 semantic rows); semantic eviction is insertion-order.
- Cache stores contain prompt and answer text; treat Redis/Postgres as sensitive stores.
- Tenant-supplied provider URLs are SSRF-checked; self-hosted private endpoints need `ALLOW_PRIVATE_PROVIDER_URLS=1`.
- Gateway keys are hashed at rest; provider credentials are AES-256-GCM encrypted; secrets are redacted from error responses and logs.

See [`SECURITY.md`](SECURITY.md) for the threat model, hardening checklist and residual risks. The Next.js control plane (`web/`) is a read/write client for the same gateway contract; it is optional.




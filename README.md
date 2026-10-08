# Relay — LLM Gateway with Semantic Caching

An OpenAI-compatible gateway that sits between your app and LLM providers (OpenAI, Anthropic, Gemini, Ollama, OpenRouter) and **cuts cost and latency by serving repeated or rephrased questions from cache — without ever returning a wrong answer.**

The problem it solves: every repeated or paraphrased prompt sent to an LLM costs money and time. Naive caching is risky, because *similar* doesn't mean *equivalent*. Relay reuses an answer only when it can prove reuse is safe — and every reply carries headers showing exactly why it was a hit or a miss.

## How it works

Every chat request flows through one pipeline:

```
client request
  → validate (bad input is rejected here, before spending a cent)
  → exact cache lookup (identical question asked before? serve it, $0)
  → semantic lookup (paraphrase of a known question + safety checks pass? serve it, $0)
  → provider call (only on a genuine miss)
  → normalize + store the answer for next time
  → reply with evidence headers
```

Two safety nets keep caching honest: up to 50 identical requests arriving at once trigger only **one** provider call (single-flight), and a pure policy function re-checks provider, model, temperature, and similarity threshold before any paraphrased answer is reused.

## What it does

- **Chat, OpenAI-style** — `POST /v1/chat/completions` accepts the familiar `model`, `messages`, `temperature`, `max_tokens`, and `stream` fields, answers in the OpenAI shape, and translates provider failures into one clean error vocabulary (`400`/`429`/`502`/`504`). Streaming arrives as Server-Sent Events and survives client disconnects.
- **Exact cache (free repeats)** — ask the identical question twice and the second answer comes from cache in milliseconds: nothing is re-sent to the provider. Formatting noise (whitespace, key order) doesn't fool it, while any real change (model, prompt, temperature) correctly misses.
- **Semantic cache (free paraphrases)** — ask the same thing in different words and, when similarity is high and every safety check passes, you get the cached answer with a similarity score in the headers. Cross-tenant, cross-model, and temperature-drifted prompts never reuse.
- **Five providers, one interface** — OpenAI, Anthropic, Gemini, Ollama, and OpenRouter behind a single adapter shape, with per-model routing (`gpt-*`, `claude-*`, `gemini-*`, `llama*`, free-tier `:free` models). New providers plug into the factory without touching the HTTP layer.
- **Stampede protection** — 50 identical requests landing at the same instant cause exactly one provider call; everyone shares the answer.
- **Self-service access (foundation ready)** — seed API keys via env config and database tables for gateway keys plus encrypted provider credentials, so apps can register once and track their own usage.
- **Built-in observability** — hit/miss counters, hit rate, avoided provider calls, and latency averages on `GET /metrics`; liveness on `/health`; provider status on `/providers`; plus a point-and-click playground UI.

## Quickstart

Prerequisites: Node.js 18+.

```bash
npm install
npm run dev        # serves http://localhost:3000 (mock provider, zero setup)
```

Try it (first call is a MISS, the repeat is a HIT — verified live):

```bash
curl -s -X POST localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"What is the capital of France?"}]}' \
  -D - -o /dev/null | grep -i 'x-cache'
# x-cache: MISS   (repeat the call → x-cache: HIT)
```

| Endpoint | Method | Notes |
|---|---|---|
| `/v1/chat/completions` | POST | Chat. Reply carries `x-cache` (`HIT`/`SEMANTIC_HIT`/`MISS`/`BYPASS`), `x-cache-hash`, and latency evidence. |
| `/health` | GET | Liveness + backend wiring (no secrets). |
| `/metrics` | GET | Counters, hit rate, avoided calls, latencies. |
| `/providers` | GET | Configured providers (never key values). |
| `/` | GET | Playground UI. |

Key configuration (`src/infrastructure/config.ts` is the only file that reads env; typos fail fast at boot):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `PROVIDER` | `3000` / `mock` | Port and default provider (`mock` needs no keys) |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPEN_ROUTER_KEY`, `OLLAMA_BASE_URL` | — | Only the providers you route to need keys (`:free` OpenRouter models need none) |
| `REDIS_URL` | — (in-memory LRU) | Exact-cache backend |
| `CACHE_TTL_S` / `CACHE_ENABLED` | `3600` / `true` | Exact-cache TTL and switch |
| `EMBEDDING_PROVIDER` / `SEMANTIC_THRESHOLD` / `SEMANTIC_TOP_K` | `mock` / `0.92` / `3` | Embedder, paraphrase-similarity cutoff, candidates |
| `SEMANTIC_STORE` / `DATABASE_URL` | `memory` / — | `pgvector` for production |
| `GATEWAY_API_KEYS` / `CRED_ENC_KEY` | — | Dev seed keys (`tenant:provider:name:key`); encryption key for stored provider credentials |

## Test report (measured, Oct 8 2026)

Full suite green: **31 files passed, 286 tests passed, 3 skipped** (the skips are an opt-in live-Redis file needing a local server), plus a clean `tsc` typecheck. Live-provider tests run only when keys are present, so CI stays offline and free. Run it yourself with `npm test` / `npm run typecheck`.

Measured performance (mock provider with 50 ms simulated latency):

| Measurement | Result |
|---|---|
| Cached reply (HIT, n=20) | avg 2.8 ms, p95 5 ms |
| Provider reply (MISS, n=5) | avg 73.2 ms, median 63 ms |
| Provider calls avoided in that run | 20 of 25 requests |
| 50 concurrent identical misses | 1 provider call, all 50 served |
| Paraphrase of a cached answer | `SEMANTIC_HIT` + similarity header, no provider call |
| Unrelated / temperature-changed / other-tenant prompt | `MISS` (no false reuse) |
| Embedder or cache outage | request still succeeds as `MISS`, never a 5xx |

<details>
<summary>Per-file breakdown (click to expand)</summary>

| Test file | Tests | What it proves |
|---|---|---|
| `tests/types/types.test.ts` | 12 | Type-level contracts |
| `tests/contract/provider-conformance.test.ts` | 23 | Every adapter behaves identically |
| `tests/contract/chat.contract.test.ts` | 10 | HTTP contract, headers, SSE, error mapping |
| `tests/integration/exact-cache.test.ts` | 12 | HIT/MISS, eviction, hash discipline |
| `tests/integration/semantic-cache.test.ts` | 7 | Paraphrase HIT, policy blocks, degradation |
| `tests/integration/providers-routing.test.ts` | 13 | Prefix routing incl. OpenRouter free tier |
| `tests/integration/provider.test.ts` | 4 | Timeout/429/502 normalization |
| `tests/integration/openai-errors.test.ts` | 7 | Upstream error mapping |
| `tests/integration/singleflight-stampede.test.ts` | 4 | 50→1 coalescing, metrics |
| `tests/integration/response-normalization.test.ts` | 6 | Canonical answers incl. streams |
| `tests/integration/http-real.test.ts` | 1 | Real-socket (no premature abort) |
| `tests/integration/ui-live.test.ts` | 4 | Playground against a real server |
| `tests/integration/playground-send.test.ts` | 2 | Playground send regression |
| `tests/integration/gemini-live.test.ts` | 3 | Real Gemini upstream (opt-in) |
| `tests/cache-eval.test.ts` | 23 | Exact/semantic/TTL/degradation batteries |
| `tests/eval-numbers.test.ts` | 4 | Latency numbers + avoided-call accounting |
| `tests/unit/chat-ui.test.ts` | 35 | Playground UI behavior |
| `tests/unit/response-normalizer.test.ts` | 23 | Markup stripping rules |
| `tests/unit/inmemory-vector.test.ts` | 9 | Vector store incl. TTL |
| `tests/unit/semantic-reuse.test.ts` | 11 | Policy reason matrix |
| `tests/unit/semantic-config.test.ts` | 10 | Semantic misconfig fails loud |
| `tests/unit/control-plane-smoke.test.ts` | 14 | Health/metrics/providers wiring |
| `tests/unit/pgvector-sql.test.ts` | 10 | SQL contract for pgvector |
| `tests/unit/auth-config.test.ts` | 9 | Seed-key parsing + auth migration |
| `tests/unit/embeddings.test.ts` | 5 | Embedder behavior + dimensions |
| `tests/unit/normalize.test.ts` | 7 | Canonical key identity rules |
| `tests/unit/singleflight.test.ts` | 5 | Coalescing incl. abort isolation |
| `tests/unit/redis-commands.test.ts` | 4 | Redis command surface |
| `tests/unit/inmemory-eviction.test.ts` | 4 | LRU bounds + TTL |
| `tests/unit/vector-eviction.test.ts` | 2 | Vector-store bounds |
| `tests/unit/metrics.test.ts` | 3 | Counter/derived-metric math |

</details>

## Coming next

Registered-vs-anonymous access lanes on the chat endpoint with per-tenant usage stats, automatic failover when a provider is down, and a measurement-backed similarity cutoff with cost-savings reporting.

## Layout

```
src/
  api/routes/      HTTP only (chat, providers, playground)
  providers/       one adapter interface + factories + capability gate
  cache/           exact cache, vector stores, single-flight
  embeddings/      mock / gemini / ollama vector providers
  policy/          pure reuse-safety decision function
  domain/          types, canonicalization, response normalization
  observability/   metrics snapshot, JSON logger
  infrastructure/  config (all env parsing), error mapping
  server.ts        composition root (wiring lives only here)
db/migrations/     SQL schemas applied automatically at boot
tests/             unit / integration / contract (mirrors src)
agent/             product spec, architecture notes, and review checklists
```

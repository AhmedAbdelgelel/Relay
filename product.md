# product.md — LLM Gateway + Semantic Cache

## 1. What are we building?
An OpenAI-compatible **LLM Gateway** that sits between clients and LLM providers to **reduce token usage, latency, and cost** via exact + semantic caching, without returning wrong answers.

Day-1 slice (this architecture): a thin, correct passthrough gateway. No cache yet.

```
Client -> POST /v1/chat/completions -> Gateway -> Provider Adapter -> LLM -> Response
```

## 2. Who uses it?
- **App developers:** send `POST /v1/chat/completions` (OpenAI shape), get back a response. No SDK change.
- **You (platform learner/operator):** learn backend fundamentals by building each layer and breaking it.
- **Future:** tenants with isolated cache/quotas, cost dashboards (Weeks 5-6).

## 3. What problem does it solve?
- Repeated / paraphrased prompts waste money and latency.
- Naive caching is dangerous: `Similarity != Equivalence != Reusability` (build plan §1).
- Gateway makes reuse **explicit, safe, measurable**.

## 4. Day-1 scope (IN)
- `POST /v1/chat/completions` (JSON, non-stream + SSE stream)
- Request validation (OpenAI subset: `model, messages, temperature, max_tokens, stream`)
- Provider abstraction (`ProviderAdapter` interface + Mock + OpenAI-compatible HTTP provider)
- Error normalization, timeouts, client-abort cancellation
- `x-request-id` correlation + structured JSON logs

## 5. Out of scope (Day-1 NON-GOALS)
- Normalization / hashing, Redis, embeddings, vector search, reuse policy
- Router, multi-provider routing, retries, rate-limit, tenancy, metrics/cost, eval harness
- Any `src/cache|embeddings|policy|routing|tenancy` code. If you import it, scope has crept.

## 6. Success — Day-1 proof (must all pass)
- [ ] Valid request returns provider response with `x-request-id`
- [ ] Invalid body returns `400` with machine-readable `{error:{code,message}}`, never calls provider
- [ ] Provider timeout (e.g. 2s in test) returns `504`, no hang
- [ ] Provider 429/500 mapped to `429/502` without leaking SDK internals
- [ ] `stream:true` returns SSE, client disconnect aborts upstream
- [ ] You can whiteboard Client -> API -> Validate -> Adapter -> LLM flow from memory

## 7. Full-project success (Weeks 1-8 reminder)
Exact cache hits, semantic reuse with measured precision/recall, tenant isolation, cost-saved metrics, eval report defending threshold choice. See build plan §§6,7,18.

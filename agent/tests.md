# Testing (minimal)

Verify behavior, not implementation. Tests derive from `implementation.md`
(FRs + invariants), the task in `loop.md`, and the acceptance criteria. A bullet
with no test is a failure.

## 1. Before coding: enumerate

- Happy path; error cases; edge cases; boundary values.
- Invalid input (400 before any provider/cache spend).
- Dependency failures: Redis down, pgvector/embedder down, provider 429/5xx/
  timeout, auth store down.
- Concurrency where relevant: single-flight stampede, waiter abort, breaker.
- Auth lanes: registered, anonymous, missing/bad/revoked/expired key, provider
  mismatch, tenant isolation.
- Regression risk: what existing behavior could this change?
- Cache safety: no reuse without policy approval; no errors/empty admitted.

## 2. Layers (pick the right one; don't over-build)

| Layer | Where | Use for |
|---|---|---|
| Unit | `tests/unit` | pure functions/policies/normalizers/parsers, builders |
| Contract | `tests/contract` | key/credential lifecycle, SQL/Redis command shape |
| Integration / e2e | `tests/e2e` | real Fastify app over HTTP/sockets, fake upstreams, cache + policy flows |
| UI | `web/src/**/*.test.tsx`, `tests/unit/*ui*` | components, evidence copy, stats, interactions |
| Live (opt-in) | `tests/integration/*-live` | real OpenRouter/Gemini/ONNX/Redis; never in the default sweep |

Prefer HTTP-level tests for endpoint contracts and unit tests for pure logic.

## 3. Running

```bash
npm test                     # hermetic: 29 files passed / 4 skipped; 371 passed, 11 skipped
npm run typecheck
npm run bench                # cache correctness benchmark: 44/44 assertions
npm run bench:perf           # repeatable perf benchmark (100k requests; --quick)
npm run eval                 # controlled threshold sweep
npm run eval:real            # real ONNX-embedding evaluation + report
cd web && npm run typecheck && npm run lint && npm test && npm run build
```

Live legs are explicit opt-ins: `npm run test:live` (sets
`OPENROUTER_LIVE_TEST=1`; needs `OPEN_ROUTER_KEY`), `GEMINI_LIVE_TEST=1`,
`EMBEDDING_LIVE_TEST=1`, `REDIS_LIVE_TEST=1`. A key in `.env` alone never
triggers live spend.

## 4. Rules

- No live provider spend in the default sweep or CI.
- No wall-clock/network dependence in unit tests; seed randomness; the mock
  embedder is deterministic.
- Failure injection via `MockProvider` (`delayMs`, `failure`) and local fake
  upstreams.
- Assert the invariant directly; a test that cannot fail is theater.
- Do not weaken/delete assertions to make a suite pass; fix the cause.
- Metrics-asserting tests call `metrics.reset()` first.

## 5. Report

```
TEST_RESULT
Status: PASS | FAIL
Tests run / passed / failed:
Failures (file > test > expected vs actual):
Required fixes:
```

Never report PASS while a required test is failing.

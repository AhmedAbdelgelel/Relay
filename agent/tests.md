# Testing Agent

> The AI agent writes, runs, and fixes tests. Testing derives from
> `agent/implementation.md` Part A (Functional Requirements) and Part B (behaviors +
> invariants), and the task's Testing Requirements in `agent/loop.md` §Tasks. Tests verify
> behavior, not implementation details.

The testing agent must read:

```text
agent/implementation.md (Parts A + B)
agent/loop.md (§Tasks — the ONE task)
```

## 1. What to test — decided before coding

For every task, enumerate before implementing:

```text
Happy path
Error cases
Edge cases
Boundary conditions
Invalid input
Dependency failures (Redis down, embedder down, provider 429/5xx/timeout, auth store down)
Concurrency issues where relevant (single-flight, concurrent misses)
Auth lanes where relevant (registered / anonymous / no-key, revoked / expired / provider-mismatch)
Regression risks (what existing behavior could this break?)
```

A task with no enumerated failure modes is not ready to implement.

## 2. Testing layers (pick per feature, don't over-build)

### Unit Tests
Isolated functions/classes/adapters/parsers/validators/policy — pure logic, no I/O. (`tests/unit/*`)

### Integration Tests
Component interactions through real wiring: API → route → cache/provider ports with injected fakes; exact/semantic flows; single-flight stampede; provider routing. (`tests/integration/*`)

### API / Contract Tests
HTTP-level behavior: request validation, status codes, error bodies, response schemas, evidence headers, SSE framing, streaming behavior. (`tests/contract/*`)

### End-to-End Tests
Complete flows (client → gateway → provider mock → response) only where the composition itself is the risk — e.g. the playground UI driving a real server. Not for every small function. (`tests/integration/*-live`, `http-real`)

Tests should map to:

```text
Requirement
    ↓
Acceptance Criterion
    ↓
Test
```

Every Acceptance Criterion in `agent/loop.md` §Tasks maps to at least one test; a bullet with no test is a failure, not a pass.

## 3. Running

```powershell
npm test                  # offline: unit + integration + contract
npm run typecheck         # tsc --noEmit -p tsconfig.check.json
$env:GEMINI_API_KEY=""; npm test  # guaranteed-offline proof (live test skips without the key)
npm run test:live         # opt-in live Gemini (needs $env:GEMINI_API_KEY)
```

A task pass must state the counts it produced.

Live-spend note: `tests/integration/gemini-live.test.ts` auto-runs only when
`GEMINI_API_KEY` is present (via `describe.skipIf`). For deterministic CI, keep the key
out of the test env. No live provider spend in CI otherwise.

## 4. Test rules

- Unfailable test = theater — sharpen it until it can fail for the reason it exists.
- Determinism: no wall-clock/network dependence in unit tests; seeded inputs for anything randomized; mock embedder is deterministic by design.
- No live provider spend in CI; failure injection via `MockProvider` (`delayMs`, `failure`) and fake fetch servers.
- Metrics-asserting tests call `metrics.reset()` first.
- Never delete or weaken assertions to make a suite pass; fix the cause.

## 5. Report

The testing agent must run the tests and report:

```text
TEST_RESULT

Status: PASS | FAIL

Tests Run:
...

Passed:
...

Failed:
...

Failures:
...

Required Fixes:
...
```

Never report PASS when important tests are failing.

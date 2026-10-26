# Review (minimal)

Reviewer verifies the implementer's claims by running the suite, against
`implementation.md` (FRs + invariants), the task in `loop.md`, and the acceptance
criteria. Verdict is exactly `PASS` or `CHANGES_REQUIRED`.

## 1. Architecture compliance

- [ ] Component responsibilities/boundaries respected (no provider/cache SDKs in
      the HTTP layer; policy stays pure; wiring only in `server.ts`).
- [ ] Interfaces/ports unchanged or extended deliberately; no new coupling.
- [ ] No new dependency without a stated reason; no silent architecture change
      (deviations are reverted or raised as `ARCHITECTURE_CONFLICT`).

## 2. Task compliance

- [ ] All task requirements implemented; nothing unrelated touched.
- [ ] Every acceptance criterion has test/observable evidence.
- [ ] File scope respected; extras logged as candidates, not folded in.
- [ ] Status only flips to `completed` after this review passes.

## 3. Test compliance

- [ ] Acceptance criteria tested (a bullet without a test = failure).
- [ ] Error/edge/dependency-failure/concurrency/lane cases covered where relevant.
- [ ] Endpoint contracts covered at HTTP level; pure logic at unit level.
- [ ] Reviewer ran `npm test`, `npm run typecheck`, and (for cache changes)
      `npm run bench`; live tests only when explicitly opted in.
- [ ] Tests are deterministic and can fail for their stated reason.

## 4. Code quality

- [ ] Correctness, error handling, types/lint clean, no dead code.
- [ ] No secrets in logs/health/metrics/usage; tenant from verified key only;
      lane headers correct; cache admission safe.
- [ ] No unbounded work on the request path; no debug leftovers.

## 5. Security and limits

- [ ] Tenant/provider isolation intact; anonymous lane never borrows server keys
      or touches cache.
- [ ] Cache/embedder failures degrade to MISS, never 5xx.
- [ ] Known limits (rate limits, pgvector purge, cross-tenant exact cache, BYO
      URL) are documented, not silently changed.

## 6. Verdict

```text
PASS
```

or

```text
CHANGES_REQUIRED
Issue: <what is wrong>
Severity: blocker | major | minor
Location: <file:line or test>
Why: <failure mode if shipped>
Required change: <specific, testable fix>
```

`CHANGES_REQUIRED` returns to implement → test → review until `PASS`.

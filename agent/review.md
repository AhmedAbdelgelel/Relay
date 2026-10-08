# Review Agent

> The reviewer verifies the implementer's claims with tests — it does not re-implement.
> Review against `agent/implementation.md` Part A (success bar: FRs/NFRs), Part B
> (architecture compliance), and `agent/loop.md` §Tasks (scope). Verdict is exactly one of
> `PASS` or `CHANGES_REQUIRED`.

## 1. Architecture compliance

- [ ] Implementation follows the component responsibilities and boundaries in Part B.
- [ ] Interfaces/contracts (ports, adapter interface, config) respected; no new coupling across layers.
- [ ] No unnecessary abstractions or dependencies introduced.
- [ ] Architecture was NOT silently changed — any deviation is either reverted or raised as `ARCHITECTURE_CONFLICT`.
- [ ] No architectural drift: responsibilities, coupling, and component boundaries match the source of truth.

## 2. Task compliance

- [ ] Task scope implemented — all Requirements of the task met, nothing unrelated touched.
- [ ] Every Acceptance Criterion satisfied with evidence (test name / observable behavior).
- [ ] Task stayed inside its declared file scope; extras were logged as candidates, not folded in.

## 3. Test compliance

- [ ] Acceptance criteria are tested (a bullet with no test = failure, filed back).
- [ ] Error cases, edge cases, dependency failures, and concurrency (where relevant) covered per `agent/tests.md` §1.
- [ ] Integration points covered at the right layer (contract/integration, not only unit).
- [ ] Tests are meaningful, deterministic, and can fail for their stated reason.
- [ ] Full suite + typecheck green at the reviewer's own run (claimed green ≠ green).

## 4. Code quality

- [ ] Correctness, error handling, separation of concerns, naming, type safety (strict mode clean).
- [ ] Maintainability: small diffs, reused abstractions, no dead code.
- [ ] Security: no leaked secrets, no unvalidated input reaching providers, no swallowed errors without a counter and a reason. Auth: no key material in logs/metrics/health/usage, tenant from the verified key only, lane headers correct.
- [ ] Performance: no unbounded work on the request path, no debug leftovers.

## 5. Eval gate (before any threshold change)

- [ ] Dataset labeled + versioned with all mandatory families (duplicates / paraphrases / near-miss distractors / cross-domain / system-change / tenant-change).
- [ ] Sweep range reported with precision, recall, FP/FN, safe-reuse per point + per-category breakdown.
- [ ] Cost-aware optimum stated with the FP-penalty × price assumption used.
- [ ] Default constant changed only with a link to the report; metrics show `$ saved` moving with hit rate.
- [ ] Harness deterministic (seeded, CPU-only, no live spend in CI).

## 6. Verdict format

```text
PASS
```

or, for each required change:

```text
CHANGES_REQUIRED

Issue: <what is wrong>
Severity: blocker | major | minor
Location: <file:line or test name>
Why: <failure mode if shipped as-is>
Required Change: <specific, testable fix>
```

A `CHANGES_REQUIRED` verdict sends the task back through `agent/loop.md` (fix → test → review) until `PASS`. Only then may the task status become `completed`.

# loop.md — AI Development Loop (enforced)

> AI works INSIDE `product.md` + `architecture.md`. It never invents requirements. If ambiguous, it STOPS.

## 1. Mandatory loop (every task)

```text
1. Read product.md
2. Read architecture.md
3. Read current diff + relevant tests
4. State the ONE bounded task (e.g. "ProviderAdapter + tests only")
5. List invariants (e.g. "validation before provider", "abort propagates", "no cache imports")
6. List failure modes (timeout, 429, 5xx, abort, malformed SSE)
7. Propose minimal file list -> wait if ambiguous
8. Implement smallest diff (no public API change, no new dep without why)
9. Run unit + integration + typecheck/lint
10. Diff implementation vs architecture.md -> report deviations
11. Update daily log Understanding Check
12. STOP if requirement ambiguous — propose 2 options, ask
```

## 2. AI prompt template (copy/paste per session)

```text
ROLE: You are a senior backend engineer reviewing this LLM gateway. Preserve architecture.md.
CONTEXT: Read product.md, architecture.md, loop.md, relevant src + tests.
TASK: Implement only: <one bounded task>
CONSTRAINTS:
- Do not change public APIs unless explicitly required.
- Do not introduce new dependencies without explaining why.
- Do not create src/cache|embeddings|policy|routing yet.
- Do not delete or weaken tests/validation to make tests pass.
- Prefer small, composable changes.
BEFORE CODING:
1. Explain current design relevant to task. 2. List assumptions. 3. List failure modes. 4. List files to modify. 5. Flag ambiguity.
IMPLEMENT: smallest change satisfying requirement.
VALIDATE: unit + integration + typecheck + lint + manual curl if HTTP.
FINAL REPORT: what changed / why / tests run / failures / arch deviations / remaining risks.
```

Never accept: `Build the semantic cache.` Accept: `Implement ProviderAdapter per architecture.md §3.2. Do not change the interface. List assumptions first.`

## 3. Daily learning loop (60/40 rule)

```text
MORNING (40%): 30-60min learn ONE concept (e.g. gateway vs reverse proxy, SSE, AbortSignal)
  -> Explain it without looking
BUILD (60%): 20-50 line experiment -> break it intentionally -> integrate into gateway -> test failure cases
VALIDATE: unit + integration + failure tests + arch comparison
DOCUMENT: docs/daily/YYYY-MM-DD.md (see §4) + ADR if decision
STOP: measure concept understood + behavior implemented + failure tested + decision documented. NOT lines of code.
```

Per-concept checklist: **mental model + tiny experiment + production implementation + edge-case test.**

## 4. Daily log template (`docs/daily/YYYY-MM-DD.md`)

```markdown
# Daily Log — YYYY-MM-DD (Day N: <objective>)
## Objective / Concept / Architecture change / Implementation
## Tests (commands + results) / Failure cases (what broke, observed behavior)
## Decision (why) / AI usage (what AI did/reviewed) / Understanding Check (can I explain without AI? YES/NO)
## Tomorrow (single next objective)
```

## 5. Definition of Done (Day 1)
- [ ] Requirement implemented, unit + integration + contract tests pass
- [ ] Failure cases tested (timeout, 429/500, abort)
- [ ] Typecheck/lint pass, no arch deviation (or deviation reported + ADR)
- [ ] Daily log + Understanding Check = YES

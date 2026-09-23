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

# LOOP.md — Strict Decision & Implementation Loop

If you can't defend a decision in one sentence, it's not a decision — it's a guess with a deadline. This loop exists so guesses don't ship. No skipping stages. No batching decisions. No "we'll fix it later" — later is when it costs 10x.

---

## GATE

State the question in one sentence and the failure mode if it's answered wrong.

- Can't state the failure mode? You don't understand the problem. Full stop.
- Don't bring me a decision you can't break. Go find out how it breaks first.

## DECIDE

One decision. Non-negotiable, all three parts:

- **Choice** — say it plainly. No hedging, no "it depends."
- **Rejected alternative(s)** — at least one, with the exact mechanism of failure. "It's worse" is not an argument, it's an opinion.
- **Invariant** — one testable statement that must always hold. If it can't be tested, it's not a decision, it's a vibe.

Missing any of the three: this is not ready. Don't move it forward.

## SPEC

The decision becomes a contract — interface, schema, signature. No logic. No implementation leaking in.

- Can't write the contract cleanly? The decision was soft. Back to DECIDE — I don't want a spec built on a decision nobody actually made.

## IMPLEMENT

Smallest slice that satisfies the spec. That's it. That's the whole job.

- Found something else while you were in there? Good — log it as its own decision. Do not fold it in quietly. Scope creep by stealth is how systems rot.
- Slice too big to stay small? The spec was too big. Split it and come back.

## VERIFY

Test the invariant. Directly. Explicitly.

- "Seems to work" gets you sent back. Every time.
- If the test can't fail, it isn't a test — it's theater. Go sharpen the invariant.

## LOCK

VERIFY passes → the decision is closed. Immutable. In the log.

- Want to change a locked decision? That's a new GATE, not an edit. I want to see the paper trail, not a git blame archaeology dig.
- This is the only thing standing between you and silent drift six months from now when nobody remembers why anything is the way it is.

---

## Non-negotiables

1. One decision per pass. Batch them and quality drops — I've watched it happen every time.
2. No decision without a stated failure mode. If you skip GATE, I will send it back.
3. No spec without a contract. Vague specs produce vague code, on schedule, every time.
4. No scope creep dressed up as thoroughness. Log it separately or it didn't happen.
5. No pass/fail based on feeling. Show me the test.
6. History doesn't get quietly rewritten. Locked means locked.

This isn't process for its own sake. It's the difference between a system you can reason about in a year and one you're afraid to touch.

## Decision log format

Each entry in `DECISIONS.md`:

```
### [ID] Short title
- Context:
- Choice:
- Rejected:
- Invariant:
- Status: open | verified | locked
```

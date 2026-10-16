# Relay — semantic threshold evaluation report

**Dataset:** `threshold-sweep/v1` — 26 labeled fixtures, minimum 3 per family, validated on every run (`validateDataset()` fails the harness loudly otherwise).

**Harness:** `scripts/eval/` — reproduce with `npm run eval` (writes this file). Deterministic: no clock, no randomness, no network, no provider spend.

## Method

The sweep runs fixture embeddings through the **real** `InMemoryVectorStore` and the **real** `isReusableSemantic` policy in production order (retrieval hit, then policy gate). Embeddings are exact: the controlled embedder reproduces a requested cosine similarity to the seeded answer to full precision, so the 0.90/0.92/0.95 boundary sits exactly where the labels say. `system-change` and `tenant-change` fixtures carry high similarity but must miss through the policy gates.

## Metric definitions

| Metric | Definition |
|---|---|
| TP / FP / FN / TN | Reuse decision vs the `mustHit` label (FP = wrong-answer reuse; FN = missed safe reuse). |
| precision | TP / (TP + FP). |
| recall | TP / (TP + FN). |
| safe-reuse rate | TP / (TP + FP) — the safety-first view: share of served-from-cache replies that were legitimate. |
| P-CHR | Paraphrase cache-hit rate: must-HIT paraphrase fixtures served / all must-HIT paraphrases. |
| net $ | `(TP + FP) × providerCallUsd − FP × fpPenaltyUsd` under the assumption below. |

## Sweep 0.60 → 0.95

| thr | TP | FP | FN | TN | precision | recall | safe-reuse | P-CHR | net $ |
|---|---|---|---|---|---|---|---|---|---|
| 0.60 | 7 | 7 | 0 | 12 | 50.0% | 100.0% | 50.0% | 100.0% | -$3.4720 |
| 0.65 | 7 | 7 | 0 | 12 | 50.0% | 100.0% | 50.0% | 100.0% | -$3.4720 |
| 0.70 | 7 | 7 | 0 | 12 | 50.0% | 100.0% | 50.0% | 100.0% | -$3.4720 |
| 0.75 | 7 | 6 | 0 | 13 | 53.8% | 100.0% | 53.8% | 100.0% | -$2.9740 |
| 0.80 | 7 | 5 | 0 | 14 | 58.3% | 100.0% | 58.3% | 100.0% | -$2.4760 |
| 0.85 | 7 | 4 | 0 | 15 | 63.6% | 100.0% | 63.6% | 100.0% | -$1.9780 |
| 0.90 | 7 | 1 | 0 | 18 | 87.5% | 100.0% | 87.5% | 100.0% | -$0.4840 |
| 0.92 | 7 | 0 | 0 | 19 | 100.0% | 100.0% | 100.0% | 100.0% | $0.0140 |
| 0.95 | 6 | 0 | 1 | 19 | 100.0% | 85.7% | 100.0% | 75.0% | $0.0120 |

## Per-category breakdown

<details><summary>TP / FP / FN per family and threshold</summary>

Cell = `TP/FP/FN`.

| family | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.92 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|
| duplicate | 3/0/0 | 3/0/0 | 3/0/0 | 3/0/0 | 3/0/0 | 3/0/0 | 3/0/0 | 3/0/0 | 3/0/0 |
| paraphrase | 4/0/0 | 4/0/0 | 4/0/0 | 4/0/0 | 4/0/0 | 4/0/0 | 4/0/0 | 4/0/0 | 3/0/1 |
| near-miss | 0/4/0 | 0/4/0 | 0/4/0 | 0/4/0 | 0/4/0 | 0/4/0 | 0/1/0 | 0/0/0 | 0/0/0 |
| topical | 0/3/0 | 0/3/0 | 0/3/0 | 0/2/0 | 0/1/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| cross-domain | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| system-change | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| tenant-change | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| unrelated | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |

</details>

## Cost-aware optimum

Assumption: **providerCallUsd = $0.0020 / call avoided** (aligns with the `SAVED_USD_PER_1K_TOKENS` example price) and **fpPenaltyUsd = $0.50 / false-positive reuse** — a wrong answer costs orders of magnitude more than an extra provider call, which is the whole point of the policy gates.

| thr | calls avoided (TP+FP) | wrong answers (FP) | net $ |
|---|---|---|---|
| 0.60 | 14 | 7 | -$3.4720 |
| 0.65 | 14 | 7 | -$3.4720 |
| 0.70 | 14 | 7 | -$3.4720 |
| 0.75 | 13 | 6 | -$2.9740 |
| 0.80 | 12 | 5 | -$2.4760 |
| 0.85 | 11 | 4 | -$1.9780 |
| 0.90 | 8 | 1 | -$0.4840 |
| 0.92 | 7 | 0 | $0.0140 |
| 0.95 | 6 | 0 | $0.0120 |

**Optimum: 0.92** — TP 7, FP 0, FN 0, net $0.0140.
- Next lower point 0.90: net -$0.4840 — 1 FP reuse (families: near-miss), 0 FN reuse (families: none).
- Next higher point 0.95: net $0.0120 — 0 FP reuse (families: none), 1 FN reuse (families: paraphrase).

`SEMANTIC_THRESHOLD` stays **0.92** — the current default; the sweep re-confirms it as the cost-aware optimum on this set. Any default change must link to this report (agent/review.md §5 gate).

## Notes

- **Legacy rows (T16):** entries with NULL `system_fingerprint` / `policy_version` skip those policy checks on read; this set is fully stamped, and the skip behaviour is pinned in `tests/unit/semantic-reuse.test.ts`.
- **Determinism (T15):** no seeded PRNG is needed — there is no randomness at all. `tests/eval-numbers.test.ts` proves two full runs agree and that this report is byte-identical across runs.

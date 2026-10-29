# Relay — real-embedding semantic evaluation (Tasks 7–8)

**Dataset:** `real-embeddings/v1` — 233 labeled prompt pairs (75 must-HIT / 158 must-MISS), fingerprint `263b84e1fdc0fab9…`. Generated deterministically by `scripts/eval/realDataset.ts`; validated on every run (the runner exits non-zero otherwise).

**Embedder:** the REAL built-in embedder — `Xenova/all-mpnet-base-v2 (q8, local ONNX)` — through the **real** `InMemoryVectorStore` and the **real** `isReusableSemantic` policy, in production order (retrieval by scoped vector search, then the reuse gate). No mock/controlled embeddings are used for any number below.

**Reproduce:** `npx tsx scripts/eval/realEmbeddings.ts` (writes this file). Hermetic: deterministic local CPU inference, no network, no provider spend. Report contains no timestamps/runtime, so two runs on the same embedder build are byte-identical.

## Headline findings

- **Safety boundary: `SEMANTIC_THRESHOLD` must be ≥ 0.95 for this embedder/corpus.** It is the lowest swept threshold with zero observed false positives (TP 45, FP 0, FN 30, precision 100.0%, recall 60.0%, net $0.3856/1k requests under the assumptions below). The higher points (0.96–0.98) have identical metrics on this corpus, so 0.95 is the empirical boundary; add margin only if you want protection against unseen traffic.
- **At a zero-FP threshold the semantic cache reuses exact/formatting duplicates only:** duplicates served 45/45, **paraphrases served 0/30.** Real paraphrase cosines span 0.7376–0.9453 (median 0.8523), while answer-changing text-level negatives reach 0.9385: the distributions overlap, and date/number edits can score HIGHER than most genuine paraphrases.
- It deliberately leaves 30 safe pair(s) uncached (each is one extra provider call) — a missed cache hit costs one call, a wrong answer costs orders of magnitude more. This is the false-positive-first trade-off, not a bug.
- **The former default 0.92 is not safe on this corpus:** TP 46, **FP 4** (precision 92.0%, FPR 2.5%), FN 29, net -$8.1552/1k. Wrong-answer reuses: `near-refund-policy-1` (near-miss, cosine 0.9208); `date-01` (date-number, cosine 0.9282); `date-11` (date-number, cosine 0.9385); `date-20` (date-number, cosine 0.9383).
- **Why the cosine alone cannot fix it:** paraphrase cosines (0.7376–0.9453) overlap text-level negatives (up to 0.9385); only byte/formatting duplicates sit at 1.0000. A threshold low enough for paraphrase reuse serves wrong answers; a threshold high enough to be safe reuses duplicates only. Safe paraphrase reuse needs an extra lexical/number/date guard and/or a verifier, validated with this same harness (see "What would make paraphrase reuse safe").
- **Current production default: 0.95** — adopted from this report's zero-false-positive boundary; the 0.92 figures above are retained as the former default so the measured risk is documented rather than erased.
- **Controlled eval vs real eval:** the controlled-cosine sweep (`threshold-sweep/v1`, prescribed cosines) has its cost-aware optimum at **0.92** with TP 7 / FP 0 / FN 0. That validates the policy math and gates, not embedding quality — the real model below is the evidence for what threshold is safe with actual sentence-transformer cosines. Note the two optima disagree: the controlled 0.92 is unsafe with real cosines.
- **Economics:** under the stated assumptions ($0.0020/provider call, $0.5000/wrong-answer reuse, local embedding ≈ $0 marginal, 5760 B/row at $0.15/GB-month), the estimated net saving is $0.3856/1k requests at the unrestricted optimum (thr 0.95 / 0.00 wrong answers per 1k) and $0.3856/1k at the safe recommendation — modest, because on this traffic mix the only safe reuse is duplicate-shaped.

## Dataset and labelling rules

Each pair is `(cached prompt, incoming query prompt)`. `mustHit = true` iff reusing the cached answer is semantically safe.

| family | pairs | must-HIT | what changes |
|---|---|---|---|
| duplicate | 45 | 45 | formatting/casing only (same question) |
| paraphrase | 30 | 30 | same information need, different wording — safe reuse |
| near-miss | 30 | 0 | same topic, different answer-critical entity/fact — must MISS |
| date-number | 24 | 0 | date, quantity, price, version, size or top-K changes |
| constraint | 24 | 0 | an added/removed constraint changes the answer (language, format, audience, negation, budget…) |
| system-change | 15 | 0 | identical user text, different system instruction |
| tenant-change | 15 | 0 | identical text/model, different tenant |
| model-change | 15 | 0 | identical text, different model id |
| generation-change | 20 | 0 | identical text, different temperature or max_tokens |
| unrelated | 15 | 0 | different topic entirely |

Synthetic-template limitation (stated up front): these are hand-authored prompts, not sampled production traffic — the domain mix and positive/negative ratio are assumptions, not measurements. They are short English prompts on one embedder model version; subtle pragmatics are labelled conservatively (answer-changing => must MISS). Re-validate on sampled real traffic before changing a default that affects users.

## Method

For each pair, one candidate row is written to a fresh production `InMemoryVectorStore` under the **cached** request scope (tenant/model/temperature/max_tokens/system fingerprint/policy version), then the incoming query is embedded and run through the production order: scoped `findSimilar(queryVec, {tenant, provider, model}, {threshold, topK})`, then `isReusableSemantic(query, hit, {provider, threshold, tenant})`. A pair is *reused* only when both stages agree. Pairs are evaluated one candidate row at a time (same single-reference method as the controlled eval), so these numbers measure embedding separability + policy, not cross-row retrieval effects — the HTTP e2e semantic suites and `npm run bench` cover the serving path.

**Thresholds swept:** 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.92, 0.95, 0.96, 0.97, 0.98. The range is extended past the controlled eval's 0.95 because real cosine distributions can place entity-swapped negatives above 0.95; a threshold only reachable outside the usual range is still a finding.

### Metric definitions

| metric | definition |
|---|---|
| TP / FP / FN / TN | reuse decision vs `mustHit`; **FP = wrong-answer reuse**, FN = missed safe reuse |
| precision | TP / (TP + FP) — share of reuses that were legitimate |
| recall | TP / (TP + FN) — share of safe reuses actually served |
| false-positive rate | FP / (FP + TN) — share of must-MISS requests wrongly served |
| semantic hit rate | (TP + FP) / N — share of all requests served from the semantic cache |
| safe-reuse rate | TP / (TP + FP) — safety-first view of the same reuses |
| calls avoided / 1k | (TP + FP) / N × 1000 |
| net $ / 1k | calls avoided × providerCallUsd − wrong answers × wrongAnswerPenaltyUsd − embedding − storage (per assumptions below) |

### Similarity calibration by family (real ONNX cosines)

| family | pairs | must-HIT | min | median | max | ≥0.90 | ≥0.95 |
|---|---|---|---|---|---|---|---|
| duplicate | 45 | 45 | 1.0000 | 1.0000 | 1.0000 | 45 | 45 |
| paraphrase | 30 | 30 | 0.7376 | 0.8523 | 0.9453 | 3 | 0 |
| near-miss | 30 | 0 | 0.5950 | 0.7949 | 0.9208 | 6 | 0 |
| date-number | 24 | 0 | 0.7568 | 0.8862 | 0.9385 | 7 | 0 |
| constraint | 24 | 0 | 0.7457 | 0.8548 | 0.9072 | 2 | 0 |
| system-change | 15 | 0 | 0.5079 | 0.6866 | 0.7865 | 0 | 0 |
| tenant-change | 15 | 0 | 1.0000 | 1.0000 | 1.0000 | 15 | 15 |
| model-change | 15 | 0 | 1.0000 | 1.0000 | 1.0000 | 15 | 15 |
| generation-change | 20 | 0 | 1.0000 | 1.0000 | 1.0000 | 20 | 20 |
| unrelated | 15 | 0 | 0.0599 | 0.1484 | 0.3283 | 0 | 0 |

## Threshold sweep (real embeddings + real store + real policy)

| thr | TP | FP | FN | TN | precision | recall | FPR | hit rate | calls avoided /1k | wrong /1k | net $ /1k |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.60 | 75 | 77 | 0 | 81 | 49.3% | 100.0% | 48.7% | 65.2% | 652.4 | 330.47 | -$163.9316 |
| 0.65 | 75 | 76 | 0 | 82 | 49.7% | 100.0% | 48.1% | 64.8% | 648.1 | 326.18 | -$161.7943 |
| 0.70 | 75 | 70 | 0 | 88 | 51.7% | 100.0% | 44.3% | 62.2% | 622.3 | 300.43 | -$148.9703 |
| 0.75 | 74 | 65 | 1 | 93 | 53.2% | 98.7% | 41.1% | 59.7% | 596.6 | 278.97 | -$138.2922 |
| 0.80 | 72 | 52 | 3 | 106 | 58.1% | 96.0% | 32.9% | 53.2% | 532.2 | 223.18 | -$110.5240 |
| 0.85 | 63 | 40 | 12 | 118 | 61.2% | 84.0% | 25.3% | 44.2% | 442.1 | 171.67 | -$84.9533 |
| 0.90 | 48 | 15 | 27 | 143 | 76.2% | 64.0% | 9.5% | 27.0% | 270.4 | 64.38 | -$31.6487 |
| 0.92 | 46 | 4 | 29 | 154 | 92.0% | 61.3% | 2.5% | 21.5% | 214.6 | 17.17 | -$8.1552 |
| 0.95 | 45 | 0 | 30 | 158 | 100.0% | 60.0% | 0.0% | 19.3% | 193.1 | 0.00 | $0.3856 |
| 0.96 | 45 | 0 | 30 | 158 | 100.0% | 60.0% | 0.0% | 19.3% | 193.1 | 0.00 | $0.3856 |
| 0.97 | 45 | 0 | 30 | 158 | 100.0% | 60.0% | 0.0% | 19.3% | 193.1 | 0.00 | $0.3856 |
| 0.98 | 45 | 0 | 30 | 158 | 100.0% | 60.0% | 0.0% | 19.3% | 193.1 | 0.00 | $0.3856 |

<details><summary>Per-family TP/FP/FN/TN at each threshold</summary>

| family | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.92 | 0.95 | 0.96 | 0.97 | 0.98 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| duplicate | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 | 45/0/0/0 |
| paraphrase | 30/0/0/0 | 30/0/0/0 | 30/0/0/0 | 29/0/1/0 | 27/0/3/0 | 18/0/12/0 | 3/0/27/0 | 1/0/29/0 | 0/0/30/0 | 0/0/30/0 | 0/0/30/0 | 0/0/30/0 |
| near-miss | 0/29/0/1 | 0/28/0/2 | 0/22/0/8 | 0/18/0/12 | 0/14/0/16 | 0/9/0/21 | 0/6/0/24 | 0/1/0/29 | 0/0/0/30 | 0/0/0/30 | 0/0/0/30 | 0/0/0/30 |
| date-number | 0/24/0/0 | 0/24/0/0 | 0/24/0/0 | 0/24/0/0 | 0/22/0/2 | 0/19/0/5 | 0/7/0/17 | 0/3/0/21 | 0/0/0/24 | 0/0/0/24 | 0/0/0/24 | 0/0/0/24 |
| constraint | 0/24/0/0 | 0/24/0/0 | 0/24/0/0 | 0/23/0/1 | 0/16/0/8 | 0/12/0/12 | 0/2/0/22 | 0/0/0/24 | 0/0/0/24 | 0/0/0/24 | 0/0/0/24 | 0/0/0/24 |
| system-change | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 |
| tenant-change | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 |
| model-change | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 |
| generation-change | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 | 0/0/0/20 |
| unrelated | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 | 0/0/0/15 |

</details>

## Chosen threshold and why

- **Recommended: 0.95** — the **lowest swept threshold with zero observed false positives** (the empirical safety boundary; higher points have identical metrics here). Result: TP 45 / FP 0 / FN 30, precision 100.0%, recall 60.0%, hit rate 19.3%.
- **What it serves:** duplicate family 45/45 (cosine 1.0000 for formatting/casing variants — the tokenizer normalises case and whitespace, so these are exact duplicates), paraphrase family **0/30** (paraphrase cosines 0.7376–0.9453; only 0 reaches 0.95).
- **Margin to the dangerous class:** the highest real cosine among text-level must-MISS pairs is **0.9385** (date-number), so the recommended threshold sits 0.0115 above it. The nearest positive that is rejected is 0.9453; the closest safe positive overall is 0.7376. Because the closest positive is *below* the highest negative, no threshold on this corpus serves paraphrases AND zero wrong answers — that is the core finding, not a tuning failure.
- **Recall cost:** 30 safe pair(s) stay uncached below 0.95 (each costs one extra provider call): par-japan-currency-2 (0.7376), par-q1-earnings-2 (0.7748), par-password-reset-1 (0.7940), par-free-plan-rate-limit-2 (0.8072), par-free-plan-rate-limit-1 (0.8155), par-password-reset-2 (0.8304), par-france-capital-2 (0.8313), par-berlin-lisbon-flights-2 (0.8359), ….
- **Metadata gates are threshold-independent:** tenant/model/system/generation swaps can have cosine 1.0000, so the embedding threshold alone would never block them; the policy gates do (verified separately below). The threshold's job is the *text-level* negatives (near-miss, date/number, constraint), and those are why it cannot be lower.
- **vs the former default 0.92:** the recommendation is higher (0.95). At 0.92 this corpus gets precision 92.0%, recall 61.3%, **4 wrong answers**, net -$8.1552/1k — so lowering/shipping 0.92 for the local embedder is not justified by these data. It would only become justifiable with an added guard (below).

## What would make paraphrase reuse safe (design implications)

These are implications of the measurements, not implemented changes: the current policy has no field that can see date/number/entity substitutions, which is why cosine is the only guard today.

- **Cheapest correct option (no code):** keep the threshold at/above the empirical boundary (0.95 here) and accept duplicate-only reuse. Semantic paraphrase reuse is effectively disabled on this corpus — that is the safe state.
- **Guard idea — lexical/number/date fingerprint:** before reuse, require that digits, dates/times, versions, prices, quantities and top-K tokens match between the cached prompt and the query (or fail closed when either contains them). On this corpus it would have blocked the 3 date/number wrong answer(s) at the former default 0.92 (e.g. 30 s vs 60 s, cosine 0.9385; December vs June, cosine 0.9383), and a keyword/entity term check is needed for entity swaps like annual-vs-monthly (`near-refund-policy-1`, cosine 0.9208). It is not in `isReusableSemantic` today and would need its own labelled set before shipping.
- **Verifier idea — cross-encoder / LLM equivalence check:** for candidates in the mid band (say 0.85–0.98) ask a small cross-encoder or a cheap LLM "same information need?" before serving. That targets exactly the overlap measured here, at the price of one extra model call on would-be hits (which the current local-embedding setup cannot do for free).
- **Better embeddings:** a larger/safer embedding model or an instruction-tuned retrieval model may separate entity swaps from paraphrases; any swap must rerun this script and update the dataset/limits rather than reusing 0.92 by habit.
- **Do not ship 0.80–0.85 for the local embedder** (suggested in the README's known-limits section): on this corpus those thresholds serve 52 and 40 wrong answers out of 158 must-MISS pairs (FPR 32.9% / 25.3%). If that README guidance is still current, it must be replaced by numbers from this report.

## False positives (wrong-answer reuses)

Highest-cosine **text-level** must-MISS pairs (near-miss / date-number / constraint / unrelated) — these are the pairs the similarity threshold has to separate. `@0.92` / `@rec` show whether that pair would be served at the former default and at the recommended threshold 0.95. Metadata-swap pairs (cosine up to 1.0000) are blocked by policy gates and excluded here; they are covered in the next section.

| family | cosine | @0.92 | @rec | cached prompt → incoming prompt |
|---|---|---|---|---|
| date-number | 0.9385 | REUSED | miss | Set the connection timeout to 30 seconds. → Set the connection timeout to 60 seconds. |
| date-number | 0.9383 | REUSED | miss | Renew the certificate before December 31, 2025. → Renew the certificate before June 30, 2025. |
| date-number | 0.9282 | REUSED | miss | Compare the 2022 and 2023 revenue figures. → Compare the 2023 and 2024 revenue figures. |
| near-miss | 0.9208 | REUSED | miss | What is the refund policy for annual subscriptions? → What is the refund policy for monthly subscriptions? |
| near-miss | 0.9162 | miss | miss | Summarize the Q1 2025 earnings report. → Summarize the Q2 2025 earnings report. |
| near-miss | 0.9130 | miss | miss | List the top five security risks in a web application. → List the top ten security risks in a web application. |
| date-number | 0.9129 | miss | miss | Rank the top five security risks in a web application. → Rank the top eight security risks in a web application. |
| near-miss | 0.9088 | miss | miss | Schedule the project kickoff meeting for March 3, 2025. → Schedule the project kickoff meeting for March 10, 2025. |
| date-number | 0.9077 | miss | miss | Book a table for 4 people at 7 pm. → Book a table for 6 people at 7 pm. |
| constraint | 0.9072 | miss | miss | How do I bake sourdough bread? → How do I bake sourdough bread in a bread machine? |
| date-number | 0.9065 | miss | miss | Schedule the launch for March 3, 2025. → Schedule the launch for April 3, 2025. |
| constraint | 0.9042 | miss | miss | Write an email asking for a deadline extension. → Write a formal email asking for a deadline extension. |

### The 4 wrong answer(s) served at the former default 0.92

| family | cosine | cached prompt → incoming prompt |
|---|---|---|
| date-number | 0.9385 | Set the connection timeout to 30 seconds. → Set the connection timeout to 60 seconds. |
| date-number | 0.9383 | Renew the certificate before December 31, 2025. → Renew the certificate before June 30, 2025. |
| date-number | 0.9282 | Compare the 2022 and 2023 revenue figures. → Compare the 2023 and 2024 revenue figures. |
| near-miss | 0.9208 | What is the refund policy for annual subscriptions? → What is the refund policy for monthly subscriptions? |

False positives by threshold (count / families):

- 0.60: **77** (near-miss, date-number, constraint)
- 0.65: **76** (near-miss, date-number, constraint)
- 0.70: **70** (near-miss, date-number, constraint)
- 0.75: **65** (near-miss, date-number, constraint)
- 0.80: **52** (near-miss, date-number, constraint)
- 0.85: **40** (near-miss, date-number, constraint)
- 0.90: **15** (near-miss, date-number, constraint)
- 0.92: **4** (near-miss, date-number)

## Policy gates (defense in depth, threshold-independent)

For the metadata families the user text can be identical, so a semantically-unsafe reuse would score cosine ≈ 1.0. To prove the gates catch that even if retrieval returned the row, the cached row was force-retrieved (cached scope) and the real policy was run with the query scope at threshold 0:

| family | pairs checked | wrong reuses allowed | observed policy reasons |
|---|---|---|---|
| system-change | 15 | 0 | system-fingerprint-mismatch×15 |
| tenant-change | 15 | 0 | tenant-mismatch×15 |
| model-change | 15 | 0 | model-mismatch×15 |
| generation-change | 20 | 0 | temperature-mismatch×10, max-tokens-mismatch×10 |

All metadata-gate violations must be 0; the runner exits non-zero otherwise. The remaining families (near-miss, date/number, constraint) differ in the prompt text and cannot be caught by a policy field: they are exactly what the similarity threshold has to separate, and the false-positive section above is their risk surface.

## Economics and admission policy

### Stated assumptions (constants in `scripts/eval/realEmbeddings.ts`)

| assumption | value | basis |
|---|---|---|
| provider cost / call avoided | $0.0020 | same assumption as the controlled eval ('DEFAULT_COST_ASSUMPTION' in scripts/eval/harness.ts) |
| wrong-answer penalty / FP reuse | $0.5000 | asymmetric by design: a wrong answer costs 250× a provider call under these constants |
| embedding cost / request | $0.0000 | local ONNX CPU: cash-marginal cost ≈ $0 (CPU time is not billed per token). Set a per-request price here if deploying a paid embedder API |
| storage cost | $0.15/GB-month | assumed managed Postgres/pgvector pricing |
| bytes / row | 5760 B | 768-d float32 embedding (3072 B) + 512 B answer + 256 B metadata, ×1.5 index overhead |
| requests per projection | 1000 | the corpus mix is treated as representative of 1,000 semantic-lookup requests |

### Per-threshold economics

| thr | calls avoided /1k | wrong answers /1k | embedding $ /1k | storage $ /1k | net $ /1k |
|---|---|---|---|---|---|
| 0.60 | 652.4 | 330.47 | $0.0000 | $0.0003 | -$163.9316 |
| 0.65 | 648.1 | 326.18 | $0.0000 | $0.0003 | -$161.7943 |
| 0.70 | 622.3 | 300.43 | $0.0000 | $0.0003 | -$148.9703 |
| 0.75 | 596.6 | 278.97 | $0.0000 | $0.0003 | -$138.2922 |
| 0.80 | 532.2 | 223.18 | $0.0000 | $0.0004 | -$110.5240 |
| 0.85 | 442.1 | 171.67 | $0.0000 | $0.0005 | -$84.9533 |
| 0.90 | 270.4 | 64.38 | $0.0000 | $0.0006 | -$31.6487 |
| 0.92 | 214.6 | 17.17 | $0.0000 | $0.0007 | -$8.1552 |
| 0.95 | 193.1 | 0.00 | $0.0000 | $0.0007 | $0.3856 |
| 0.96 | 193.1 | 0.00 | $0.0000 | $0.0007 | $0.3856 |
| 0.97 | 193.1 | 0.00 | $0.0000 | $0.0007 | $0.3856 |
| 0.98 | 193.1 | 0.00 | $0.0000 | $0.0007 | $0.3856 |

**Break-even wrong-answer cost: $0.0020.** A false-positive reuse already costs more than the provider call it avoids once a wrong answer costs more than $0.0020 — which is why the recommendation optimises for zero FPs rather than maximum hit rate. Storage and embedding costs are negligible at these assumptions (fractions of a cent per 1k requests); latency is the other real cost of an embedding-backed lookup and is not monetised here (see `npm run bench`: local ONNX inference ≈ 31 ms warm per short prompt).

### Admission policy (explicit)

**Admitted to the semantic cache:** non-streaming, registered-lane requests that reached a provider and produced a **non-empty, normalized success response**. Provider errors, empty/whitespace-only answers, malformed cached rows (bad shape => evicted) and streaming responses are never admitted or served. Anonymous try-out requests never read or write either cache.

**Reuse requires, in order:** exact-cache miss, a scoped vector hit (same tenant + provider + model, similarity ≥ threshold), and a passing `isReusableSemantic` decision — model id, temperature, max_tokens, tenant, provider, system-message fingerprint, policy version, non-empty content, and the sampling-field gate below all re-checked at read time. Rows stamped with an older policy version are refused (`policy-version-mismatch`), so rows admitted before policy v2 cannot be reused; legacy rows with no fingerprint/policy version skip those two checks, so operators should re-warm old rows after changing system defaults.

**Sampling/shaping fields (`top_p`, `stop`): no semantic reuse.** The semantic store does not record these fields, so a stored answer cannot be proven equivalent to a request that sets them. The LIVE policy is checked against a row that would otherwise be a perfect match (policy v2):

| request sets | reusable? | policy reason |
|---|---|---|
| top_p | no | unsupported-sampling-field |
| stop | no | unsupported-sampling-field |

The live policy refuses both fields, and `src/api/routes/chat.ts` additionally skips semantic lookup/admission when either is set (defense in depth); the exact cache still serves such requests because its canonical identity includes both fields. Unknown JSON fields are rejected by the strict request schema rather than silently dropped.

**Any future generation field** (`top_k`, `seed`, `response_format`, penalties, tools) must enter BOTH the exact-cache key AND `isReusableSemantic` before semantic reuse can be considered safe for it; until then the safest contract is to reject it at the request schema (as the strict schema does for unknown fields) rather than accept a field the gateway drops.

**Low confidence = no reuse.** The decision is deterministic: below the threshold there is no fallback, no probabilistic reuse and no best-effort serving — the request goes to the provider and is re-admitted. The threshold is the only confidence dial; this report recommends the safety-first value above.

**Trade-off:** a false positive serves a fluent, plausible, wrong answer; a false negative costs one provider call. The threshold table is the dial: lower thresholds raise calls avoided but serve wrong answers at a superlinear cost under the stated penalty, so the recommendation is the lowest-risk point. `semanticHitRate` and `wrongAnswersPer1k` above make that trade-off explicit per threshold.

## Comparison with the controlled-embedding eval

The controlled eval (`scripts/eval/realDataset`-independent; `npm run eval`) prescribes the cosine per fixture and therefore tests the threshold sweep/policy logic exactly. It cannot measure model quality. Side by side:

| eval | dataset | embeddings | cost-aware optimum | TP/FP/FN/TN at optimum | precision | recall | what it proves |
|---|---|---|---|---|---|---|---|
| controlled | threshold-sweep/v1 (26 fixtures, 7 must-HIT) | prescribed cosines | 0.92 | 7/0/0/19 | 100.0% | 100.0% | threshold math + policy gates are correct |
| real (this report) | real-embeddings/v1 (233 pairs, 75 must-HIT) | real ONNX model | 0.95 | 45/0/30/158 | 100.0% | 60.0% | embedding quality / safe threshold for THIS model |

The controlled optimum (0.92) is a property of its prescribed cosine values; it is not evidence that real paraphrases clear that bar. The real recommendation above is the number to use for deployments that enable `EMBEDDING_PROVIDER=local`.

## Limitations

- **Synthetic corpus, not traffic:** hand-authored pairs; domain mix and positive/negative ratio are assumptions. Treat the threshold as validated for this corpus, and re-validate on a sample of real (anonymised) production prompts before a default change.
- **Single embedder configuration:** English prompts, `Xenova/all-mpnet-base-v2` q8, 768-d, default pooling. Other models/quantisations/languages will have different cosine distributions; rerun this eval when swapping the embedder.
- **Question-level labels:** "safe reuse" is judged by construction, not by an LLM judge or human annotators. Ambiguous cases are labelled conservatively (answer-changing => must MISS).
- **One candidate row per pair:** this isolates embedding separability + policy. Retrieval among many rows, single-flight and the HTTP layer are covered by the e2e suites and `npm run bench`, not here.
- **Determinism scope:** local CPU inference is deterministic on the same model/onnxruntime build; cross-machine floating-point differences could flip a pair sitting exactly on a threshold. The report itself has no clock/randomness.
- **Economics are assumptions, not invoices:** provider price, wrong-answer penalty, local-embedding marginal cost and storage price are stated constants; change them in `scripts/eval/realEmbeddings.ts` and rerun.

## Reproduce

```bash
npx tsx scripts/eval/realEmbeddings.ts   # writes evaluation/real-embeddings-report.md, exits non-zero on gate failure
npm run eval                              # existing controlled-cosine report (unchanged)
```

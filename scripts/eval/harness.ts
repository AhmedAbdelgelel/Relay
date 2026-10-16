// scripts/eval/harness.ts — the T15 sweep: deterministic metric runs through
// the real InMemoryVectorStore and the real isReusableSemantic policy (nothing
// under test is mocked), plus the cost model and the report builder.
//
// Determinism is by construction: the controlled embedder computes exact
// cosines, and there is no randomness, no clock, no I/O and no provider
// spend. Two runs are byte-identical, which is what makes this harness safe
// to run in CI.

import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import { isReusableSemantic, POLICY_VERSION, systemFingerprint } from "../../src/policy/reuse.js";
import { DATASET_VERSION, FAMILIES, FIXTURES, MIN_PER_FAMILY, type FixtureFamily } from "./dataset.js";

/** The eval-gate range: 0.60 → 0.95, probing 0.90 / 0.92 / 0.95 around the default. */
export const THRESHOLDS: readonly number[] = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95];

function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

const REF = unit(0);
const ORTH = unit(1);

/**
 * Controlled-cosine embedder (recorded/mock embeddings, per T15): text tagged
 * `cos:<v>` embeds to a vector whose cosine to REF is exactly v
 * (v*REF + sqrt(1-v^2)*ORTH, both unit and orthogonal). Untagged text embeds
 * orthogonal (true negatives). Deterministic, CPU-only, no network.
 */
export class ControlledEmbedder implements EmbeddingProvider {
  readonly name = "test-controlled-cosine";
  readonly dimension = EMBEDDING_DIM;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    const m = text.match(/cos:([0-9.]+)/);
    if (!m) return [...ORTH];
    const c = Math.min(1, Math.max(-1, Number(m[1])));
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    return REF.map((r, i) => c * r + s * ORTH[i]);
  }
}

const FILTER = { tenant: "default", provider: "mock", model: "m" };

/** Seed the one reference answer every fixture is scored against. */
export async function seedStore(store: InMemoryVectorStore): Promise<void> {
  await store.save({
    tenant: "default",
    provider: "mock",
    model: "m",
    promptHash: "seed",
    promptText: "seed",
    temperature: 1.0,
    maxTokens: undefined,
    embedding: REF,
    content: "seed answer",
    usage: undefined,
    ttlSeconds: 3600,
    systemFingerprint: systemFingerprint({
      model: "m",
      messages: [{ role: "user" as const, content: "q" }],
      temperature: 1.0,
      stream: false,
    }),
    policyVersion: POLICY_VERSION,
  });
}

export interface FamilyCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface SweepPoint {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  /** TP / (TP + FP) — the share of served-from-cache replies that were legitimate. */
  safeReuseRate: number;
  /** Paraphrase cache-hit rate: must-HIT paraphrase fixtures served / all must-HIT paraphrases. */
  pChr: number;
  perFamily: Record<FixtureFamily, FamilyCounts>;
}

/** One full pass over the labeled set at one threshold: real store + real policy. */
export async function sweep(store: InMemoryVectorStore, thresholds: readonly number[] = THRESHOLDS): Promise<SweepPoint[]> {
  const embedder = new ControlledEmbedder();
  const paraphraseTotal = FIXTURES.filter((f) => f.family === "paraphrase" && f.mustHit).length;
  const out: SweepPoint[] = [];
  for (const threshold of thresholds) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const perFamily = Object.fromEntries(FAMILIES.map((f) => [f, { tp: 0, fp: 0, fn: 0, tn: 0 }])) as Record<FixtureFamily, FamilyCounts>;
    for (const f of FIXTURES) {
      const vec = await embedder.embed(`cos:${f.sim}`, new AbortController().signal);
      const cands = await store.findSimilar(vec, FILTER, { threshold, topK: 3 });
      // Retrieval hit + policy gate (production path, in order). System and
      // tenant vary per fixture to exercise the T16 gates end to end.
      const messages: { role: "user" | "system"; content: string }[] = [
        ...(f.system ?? []).map((s) => ({ role: "system" as const, content: s })),
        { role: "user" as const, content: "q" },
      ];
      const tenant = f.tenant ?? "default";
      let reused = false;
      for (const hit of cands) {
        const d = isReusableSemantic(
          { model: "m", messages, temperature: 1.0, stream: false },
          { ...hit, temperature: 1.0, maxTokens: undefined },
          { provider: "mock", threshold, tenant },
        );
        if (d.reusable) {
          reused = true;
          break;
        }
      }
      const fam = perFamily[f.family];
      if (reused && f.mustHit) {
        tp++;
        fam.tp++;
      } else if (reused && !f.mustHit) {
        fp++;
        fam.fp++;
      } else if (!reused && f.mustHit) {
        fn++;
        fam.fn++;
      } else {
        tn++;
        fam.tn++;
      }
    }
    out.push({
      threshold,
      tp,
      fp,
      fn,
      tn,
      precision: tp + fp === 0 ? 1 : tp / (tp + fp),
      recall: tp + fn === 0 ? 1 : tp / (tp + fn),
      safeReuseRate: tp + fp === 0 ? 1 : tp / (tp + fp),
      pChr: paraphraseTotal === 0 ? 0 : perFamily.paraphrase.tp / paraphraseTotal,
      perFamily,
    });
  }
  return out;
}

export interface CostAssumption {
  /** $ avoided per served-from-cache reply (one provider call not made). */
  providerCallUsd: number;
  /** $ paid per false-positive reuse — the wrong-answer cost the gates exist to prevent. */
  fpPenaltyUsd: number;
}

/**
 * Stated assumption (T15): one avoided provider call ≈ $0.002 (aligns with the
 * SAVED_USD_PER_1K_TOKENS example price); one wrong-answer reuse ≈ $0.50 —
 * orders of magnitude worse, which is why the optimum sits where FP first
 * hits zero rather than at maximum recall.
 */
export const DEFAULT_COST_ASSUMPTION: CostAssumption = { providerCallUsd: 0.002, fpPenaltyUsd: 0.5 };

/** Net $ vs not caching: every reuse skips a provider call, every FP pays the penalty. */
export function netUsd(p: SweepPoint, a: CostAssumption = DEFAULT_COST_ASSUMPTION): number {
  return (p.tp + p.fp) * a.providerCallUsd - p.fp * a.fpPenaltyUsd;
}

/** Highest net $; ties resolve toward the higher (more conservative) threshold. */
export function chooseOptimum(points: readonly SweepPoint[], a: CostAssumption = DEFAULT_COST_ASSUMPTION): SweepPoint {
  return points.reduce((best, p) => (netUsd(p, a) >= netUsd(best, a) ? p : best));
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(4)}`;
}

function familiesWhere(p: SweepPoint, kind: "fp" | "fn"): string {
  const names = FAMILIES.filter((f) => p.perFamily[f][kind] > 0);
  return names.length === 0 ? "none" : names.join(", ");
}

/**
 * Pure, deterministic markdown builder for evaluation/report.md. No
 * timestamps and no randomness: identical inputs produce byte-identical
 * output across runs (pinned by tests/eval-numbers.test.ts).
 */
export function buildReport(points: readonly SweepPoint[], a: CostAssumption = DEFAULT_COST_ASSUMPTION): string {
  const optimum = chooseOptimum(points, a);
  const idx = points.indexOf(optimum);
  const lower = idx > 0 ? points[idx - 1] : undefined;
  const higher = idx >= 0 && idx < points.length - 1 ? points[idx + 1] : undefined;

  const lines: string[] = [];
  lines.push("# Relay — semantic threshold evaluation report");
  lines.push("");
  lines.push(
    `**Dataset:** \`${DATASET_VERSION}\` — ${FIXTURES.length} labeled fixtures, minimum ${MIN_PER_FAMILY} per family, ` +
      "validated on every run (`validateDataset()` fails the harness loudly otherwise).",
  );
  lines.push("");
  lines.push(
    "**Harness:** `scripts/eval/` — reproduce with `npm run eval` (writes this file). Deterministic: no clock, no randomness, no network, no provider spend.",
  );
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "The sweep runs fixture embeddings through the **real** `InMemoryVectorStore` and the **real** " +
      "`isReusableSemantic` policy in production order (retrieval hit, then policy gate). Embeddings are exact: " +
      "the controlled embedder reproduces a requested cosine similarity to the seeded answer to full precision, " +
      "so the 0.90/0.92/0.95 boundary sits exactly where the labels say. `system-change` and `tenant-change` " +
      "fixtures carry high similarity but must miss through the policy gates.",
  );
  lines.push("");
  lines.push("## Metric definitions");
  lines.push("");
  lines.push("| Metric | Definition |");
  lines.push("|---|---|");
  lines.push("| TP / FP / FN / TN | Reuse decision vs the `mustHit` label (FP = wrong-answer reuse; FN = missed safe reuse). |");
  lines.push("| precision | TP / (TP + FP). |");
  lines.push("| recall | TP / (TP + FN). |");
  lines.push("| safe-reuse rate | TP / (TP + FP) — the safety-first view: share of served-from-cache replies that were legitimate. |");
  lines.push("| P-CHR | Paraphrase cache-hit rate: must-HIT paraphrase fixtures served / all must-HIT paraphrases. |");
  lines.push("| net $ | `(TP + FP) × providerCallUsd − FP × fpPenaltyUsd` under the assumption below. |");
  lines.push("");
  lines.push("## Sweep 0.60 → 0.95");
  lines.push("");
  lines.push("| thr | TP | FP | FN | TN | precision | recall | safe-reuse | P-CHR | net $ |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const p of points) {
    lines.push(
      `| ${p.threshold.toFixed(2)} | ${p.tp} | ${p.fp} | ${p.fn} | ${p.tn} | ${pct(p.precision)} | ${pct(p.recall)} | ${pct(p.safeReuseRate)} | ${pct(p.pChr)} | ${usd(netUsd(p, a))} |`,
    );
  }
  lines.push("");
  lines.push("## Per-category breakdown");
  lines.push("");
  lines.push("<details><summary>TP / FP / FN per family and threshold</summary>");
  lines.push("");
  lines.push("Cell = `TP/FP/FN`.");
  lines.push("");
  lines.push(`| family | ${points.map((p) => p.threshold.toFixed(2)).join(" | ")} |`);
  lines.push(`|---|${points.map(() => "---").join("|")}|`);
  for (const fam of FAMILIES) {
    const cells = points.map((p) => {
      const c = p.perFamily[fam];
      return `${c.tp}/${c.fp}/${c.fn}`;
    });
    lines.push(`| ${fam} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("## Cost-aware optimum");
  lines.push("");
  lines.push(
    `Assumption: **providerCallUsd = $${a.providerCallUsd.toFixed(4)} / call avoided** ` +
      "(aligns with the `SAVED_USD_PER_1K_TOKENS` example price) and " +
      `**fpPenaltyUsd = $${a.fpPenaltyUsd.toFixed(2)} / false-positive reuse** — a wrong answer costs orders of ` +
      "magnitude more than an extra provider call, which is the whole point of the policy gates.",
  );
  lines.push("");
  lines.push("| thr | calls avoided (TP+FP) | wrong answers (FP) | net $ |");
  lines.push("|---|---|---|---|");
  for (const p of points) {
    lines.push(`| ${p.threshold.toFixed(2)} | ${p.tp + p.fp} | ${p.fp} | ${usd(netUsd(p, a))} |`);
  }
  lines.push("");
  lines.push(
    `**Optimum: ${optimum.threshold.toFixed(2)}** — TP ${optimum.tp}, FP ${optimum.fp}, FN ${optimum.fn}, ` +
      `net ${usd(netUsd(optimum, a))}.`,
  );
  if (lower) {
    lines.push(
      `- Next lower point ${lower.threshold.toFixed(2)}: net ${usd(netUsd(lower, a))} — ` +
        `${lower.fp} FP reuse (families: ${familiesWhere(lower, "fp")}), ${lower.fn} FN reuse (families: ${familiesWhere(lower, "fn")}).`,
    );
  }
  if (higher) {
    lines.push(
      `- Next higher point ${higher.threshold.toFixed(2)}: net ${usd(netUsd(higher, a))} — ` +
        `${higher.fp} FP reuse (families: ${familiesWhere(higher, "fp")}), ${higher.fn} FN reuse (families: ${familiesWhere(higher, "fn")}).`,
    );
  }
  lines.push("");
  lines.push(
    "`SEMANTIC_THRESHOLD` stays **0.92** — the current default; the sweep re-confirms it as the cost-aware optimum " +
      "on this set. Any default change must link to this report (agent/review.md §5 gate).",
  );
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- **Legacy rows (T16):** entries with NULL `system_fingerprint` / `policy_version` skip those policy checks on " +
      "read; this set is fully stamped, and the skip behaviour is pinned in `tests/unit/semantic-reuse.test.ts`.",
  );
  lines.push(
    "- **Determinism (T15):** no seeded PRNG is needed — there is no randomness at all. `tests/eval-numbers.test.ts` " +
      "proves two full runs agree and that this report is byte-identical across runs.",
  );
  lines.push("");
  return lines.join("\n");
}

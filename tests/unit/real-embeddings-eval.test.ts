// tests/unit/real-embeddings-eval.test.ts — contract tests for the REAL-embedding
// evaluation (Tasks 7–8). No ONNX inference here: a deterministic "tagged"
// embedder replaces the real model so the tests pin the dataset contract, the
// production store+policy wiring, the metric/economics math and the exit gate
// without the ~13 s model load. The real-model run itself is the script
// (`npx tsx scripts/eval/realEmbeddings.ts`, report in evaluation/).

import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import {
  MAX_TOTAL_PAIRS,
  MIN_REAL_PER_FAMILY,
  MIN_TOTAL_PAIRS,
  REAL_DATASET_VERSION,
  REAL_FAMILIES,
  REAL_PAIRS,
  buildRealDataset,
  datasetFingerprint,
  validateRealDataset,
  type LabeledPair,
  type PromptScope,
} from "../../scripts/eval/realDataset.js";
import {
  REAL_COST_ASSUMPTIONS,
  bytesPerRow,
  buildSweepPoints,
  checkMetadataPolicyDefense,
  checkSamplingFieldAdmission,
  chooseRecommendedThreshold,
  cosineSimilarity,
  evaluatePairs,
} from "../../scripts/eval/realEmbeddings.js";

/** Contract test for the real corpus: version, counts and label invariants. */
describe("real-embedding dataset contract", () => {
  it(`dataset ${REAL_DATASET_VERSION} is valid, versioned and inside the 200–500 pair budget`, () => {
    const validation = validateRealDataset();
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.total).toBe(REAL_PAIRS.length);
    expect(validation.total).toBeGreaterThanOrEqual(MIN_TOTAL_PAIRS);
    expect(validation.total).toBeLessThanOrEqual(MAX_TOTAL_PAIRS);
    expect(validation.positives).toBeGreaterThanOrEqual(40);
    expect(validation.negatives).toBeGreaterThanOrEqual(100);
    for (const family of REAL_FAMILIES) {
      expect(validation.counts[family], `family ${family}`).toBeGreaterThanOrEqual(MIN_REAL_PER_FAMILY[family]);
    }
  });

  it("is deterministic and pinned by a content fingerprint", () => {
    const rebuilt = buildRealDataset();
    expect(rebuilt).toHaveLength(REAL_PAIRS.length);
    expect(datasetFingerprint(rebuilt)).toBe(datasetFingerprint());
    // Version pin: any dataset edit must bump REAL_DATASET_VERSION and update
    // this fingerprint (and the report), so silent label drift cannot ship.
    expect(datasetFingerprint()).toBe("263b84e1fdc0fab9ce804f1be012414585e29296809b090b13338a589ceca1d3");
  });

  it("fails validation when a must-MISS pair is relabelled as safe", () => {
    const target = REAL_PAIRS.find((p) => !p.mustHit && p.family === "near-miss");
    expect(target).toBeDefined();
    const broken = REAL_PAIRS.map((p) => (p.id === target?.id ? { ...p, mustHit: true } : p));
    const validation = validateRealDataset(broken);
    expect(validation.ok).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it("keeps the required family set present", () => {
    const present = new Set(REAL_PAIRS.map((p) => p.family));
    for (const required of [
      "duplicate",
      "paraphrase",
      "near-miss",
      "date-number",
      "constraint",
      "system-change",
      "tenant-change",
      "model-change",
      "generation-change",
      "unrelated",
    ] as const) {
      expect(present.has(required), `missing family ${required}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic tagged embedder: `class:<n>` becomes unit vector n, so the
// cosine between two texts is exactly 1 (same tag) or 0 (different tag). That
// lets the tests drive the real store + policy without the ONNX model.
// ---------------------------------------------------------------------------

class TaggedEmbedder implements EmbeddingProvider {
  readonly name = "test-tagged";
  readonly dimension = EMBEDDING_DIM;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    const match = /class:(\d+)/.exec(text);
    const vec = new Array<number>(EMBEDDING_DIM).fill(0);
    vec[match ? Number(match[1]) % EMBEDDING_DIM : EMBEDDING_DIM - 1] = 1;
    return vec;
  }
}

const BASE_SCOPE: PromptScope = { tenant: "tenant-a", model: "relay-small", temperature: 1.0 };

function mkPair(
  id: string,
  family: LabeledPair["family"],
  cachedPrompt: string,
  queryPrompt: string,
  mustHit: boolean,
  queryScope: PromptScope = { ...BASE_SCOPE },
  cachedScope: PromptScope = { ...BASE_SCOPE },
): LabeledPair {
  return { id, family, cachedPrompt, queryPrompt, cachedScope, queryScope, mustHit };
}

const FIXTURE_PAIRS: readonly LabeledPair[] = [
  mkPair("dup", "duplicate", "class:0 same question", "class:0 same question", true),
  mkPair("par", "paraphrase", "class:1 alpha question", "class:1 alpha reworded", true),
  mkPair("near", "near-miss", "class:2 alpha topic", "class:3 beta topic", false),
  mkPair("ten", "tenant-change", "class:4 shared question", "class:4 shared question", false, { ...BASE_SCOPE, tenant: "tenant-b" }),
  mkPair("mod", "model-change", "class:5 shared question", "class:5 shared question", false, { ...BASE_SCOPE, model: "relay-large" }),
  mkPair("gen", "generation-change", "class:6 shared question", "class:6 shared question", false, { ...BASE_SCOPE, temperature: 0.3 }),
  mkPair("sys", "system-change", "class:7 shared question", "class:7 shared question", false, {
    ...BASE_SCOPE,
    system: "You must answer in French only.",
  }),
];

describe("real-embedding evaluation walk (real store + real policy, fake vectors)", () => {
  it("reuses safe pairs and blocks near-miss and every metadata swap", async () => {
    const results = await evaluatePairs(FIXTURE_PAIRS, new TaggedEmbedder(), [0.9, 0.99]);
    expect(results.map((r) => r.id)).toEqual(FIXTURE_PAIRS.map((p) => p.id));
    const byId = new Map(results.map((r) => [r.id, r] as const));

    expect(byId.get("dup")!.cosine).toBe(1);
    expect(byId.get("dup")!.reusedByThreshold).toEqual([true, true]);
    expect(byId.get("par")!.reusedByThreshold).toEqual([true, true]);

    expect(byId.get("near")!.cosine).toBe(0);
    expect(byId.get("near")!.reusedByThreshold).toEqual([false, false]);
    expect(byId.get("near")!.reasonsByThreshold[0]).toBe("below-threshold");

    expect(byId.get("ten")!.scopeMatch).toBe(false);
    expect(byId.get("ten")!.reasonsByThreshold[0]).toBe("scope-mismatch");
    expect(byId.get("mod")!.scopeMatch).toBe(false);
    expect(byId.get("mod")!.reasonsByThreshold[0]).toBe("scope-mismatch");

    expect(byId.get("gen")!.scopeMatch).toBe(true);
    expect(byId.get("gen")!.reasonsByThreshold[0]).toBe("temperature-mismatch");
    expect(byId.get("sys")!.reasonsByThreshold[0]).toBe("system-fingerprint-mismatch");
    expect(results.filter((r) => !r.mustHit).every((r) => !r.reusedByThreshold[0])).toBe(true);
  });

  it("computes the confusion matrix + economics per threshold and prefers the lower tie", async () => {
    const results = await evaluatePairs(FIXTURE_PAIRS, new TaggedEmbedder(), [0.9, 0.99]);
    const points = buildSweepPoints(results, [0.9, 0.99]);
    const at = points[0]!;
    const assumptions = REAL_COST_ASSUMPTIONS;
    expect(at.tp).toBe(2);
    expect(at.fp).toBe(0);
    expect(at.fn).toBe(0);
    expect(at.tn).toBe(5);
    expect(at.precision).toBe(1);
    expect(at.recall).toBe(1);
    expect(at.falsePositiveRate).toBe(0);
    expect(at.semanticHitRate).toBeCloseTo(2 / 7, 10);
    expect(at.providerCallsAvoidedPer1k).toBeCloseTo((2 / 7) * 1000, 6);
    expect(at.wrongAnswersPer1k).toBe(0);
    const storedRowsPer1k = (at.fn + at.tn) * (assumptions.requestsPerSample / at.total);
    const expectedNet =
      at.providerCallsAvoidedPer1k * assumptions.providerCallUsd -
      at.wrongAnswersPer1k * assumptions.wrongAnswerPenaltyUsd -
      assumptions.requestsPerSample * assumptions.embeddingUsdPerRequest -
      (storedRowsPer1k * bytesPerRow() * assumptions.storageUsdPerGbMonth) / 1e9;
    expect(at.netSavingsPer1kUsd).toBeCloseTo(expectedNet, 6);

    // Both thresholds have FP=0 and identical TP, so the tie must resolve to
    // the LOWER (empirical-boundary) threshold.
    const recommended = chooseRecommendedThreshold(points);
    expect(recommended?.threshold).toBe(0.9);
  });
});

describe("metadata policy gates (defense in depth)", () => {
  it("blocks tenant/model/generation/system swaps even when retrieval leaks the row", async () => {
    const defense = await checkMetadataPolicyDefense(FIXTURE_PAIRS, new TaggedEmbedder(), 0.9);
    const byFamily = new Map(defense.map((d) => [d.family, d] as const));
    expect(defense.every((d) => d.violations === 0)).toBe(true);
    expect(byFamily.get("tenant-change")!.checked).toBe(1);
    expect(byFamily.get("tenant-change")!.reasons["tenant-mismatch"]).toBe(1);
    expect(byFamily.get("model-change")!.reasons["model-mismatch"]).toBe(1);
    expect(byFamily.get("generation-change")!.reasons["temperature-mismatch"]).toBe(1);
    expect(byFamily.get("system-change")!.reasons["system-fingerprint-mismatch"]).toBe(1);
  });

  it("refuses semantic reuse for requests that set top_p or stop (sampling-field admission)", () => {
    const sampling = checkSamplingFieldAdmission();
    expect(sampling.decisions.map((d) => d.field)).toEqual(["top_p", "stop"]);
    for (const decision of sampling.decisions) {
      // The exact reason string is owned by src/policy/reuse.ts; the invariant
      // that matters here is that a request with a sampling field is refused.
      expect(decision.reusable, `${decision.field} must not reuse`).toBe(false);
      expect(decision.reason).not.toBe("ok");
    }
    expect(sampling.blocked).toBe(true);
  });
});

describe("economics constants and cosine helper", () => {
  it("pins the stated assumptions used by the report", () => {
    expect(REAL_COST_ASSUMPTIONS.providerCallUsd).toBe(0.002);
    expect(REAL_COST_ASSUMPTIONS.wrongAnswerPenaltyUsd).toBe(0.5);
    expect(REAL_COST_ASSUMPTIONS.embeddingUsdPerRequest).toBe(0);
    // 768 * 4 B embedding + 512 B answer + 256 B metadata, × 1.5 index overhead
    expect(bytesPerRow()).toBe(5760);
  });

  it("cosine of identical unit vectors is 1 and orthogonal is 0", () => {
    const a = new Array<number>(EMBEDDING_DIM).fill(0);
    a[0] = 1;
    const b = new Array<number>(EMBEDDING_DIM).fill(0);
    b[1] = 1;
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 12);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 12);
    expect(cosineSimilarity(a, new Array<number>(EMBEDDING_DIM).fill(0))).toBe(0);
  });
});

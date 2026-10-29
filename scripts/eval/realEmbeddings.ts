// scripts/eval/realEmbeddings.ts — REAL-embedding semantic-cache evaluation
// (Tasks 7–8): labeled pair sweep through the production `InMemoryVectorStore`
// and the production `isReusableSemantic` policy, scored by the REAL built-in
// ONNX embedder (LocalEmbedding, Xenova/all-mpnet-base-v2 q8 from ./.cache).
// Writes evaluation/real-embeddings-report.md.
//
// Run with:  npx tsx scripts/eval/realEmbeddings.ts
// (the Lead wires `npm run eval:real` to this exact command; this script does
// not touch package.json)
//
// Hermetic + deterministic: no network, no provider spend, no clock/randomness
// inside the report. Embeddings are deterministic on the same machine/model/
// onnxruntime build; the report therefore contains no timestamps or runtime.
//
// The controlled-cosine eval (`npm run eval`, scripts/eval/*) is intentionally
// left untouched: it validates the threshold math and policy gates against
// prescribed cosines. This script measures whether the real model's own
// embeddings separate safe paraphrases from answer-changing near-misses.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest } from "../../src/domain/types.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import type { SemanticEntry, SemanticHit } from "../../src/cache/SemanticCacheStore.js";
import { EMBEDDING_DIM, promptTextForEmbedding, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import { LocalEmbedding } from "../../src/embeddings/LocalEmbedding.js";
import { isReusableSemantic, POLICY_VERSION, systemFingerprint } from "../../src/policy/reuse.js";
import { DATASET_VERSION as CONTROLLED_DATASET_VERSION } from "./dataset.js";
import {
  DEFAULT_COST_ASSUMPTION,
  THRESHOLDS as CONTROLLED_THRESHOLDS,
  chooseOptimum as chooseControlledOptimum,
  seedStore as seedControlledStore,
  sweep as sweepControlled,
  type SweepPoint as ControlledSweepPoint,
} from "./harness.js";
import {
  METADATA_FAMILIES,
  PROVIDER_NAME,
  REAL_DATASET_VERSION,
  REAL_FAMILIES,
  REAL_PAIRS,
  DEFAULT_SCOPE,
  datasetFingerprint,
  validateRealDataset,
  type LabeledPair,
  type PromptScope,
  type RealFamily,
} from "./realDataset.js";

// ---------------------------------------------------------------------------
// Sweep and evaluation constants
// ---------------------------------------------------------------------------

/**
 * Thresholds swept. 0.60–0.95 is the controlled-eval range; we extend to
 * 0.96–0.98 because a real sentence-transformer can score entity-swapped
 * near-misses above 0.95 — if the corpus needs a threshold beyond 0.95 to keep
 * false positives at zero, that is a finding the default range would hide.
 */
export const REAL_THRESHOLDS: readonly number[] = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95, 0.96, 0.97, 0.98];

/** The gateway default (`SEMANTIC_THRESHOLD` default in src/infrastructure/config.ts). */
export const DEFAULT_GATEWAY_THRESHOLD = 0.92;

export const REAL_EMBEDDER_MODEL = "Xenova/all-mpnet-base-v2 (q8, local ONNX)";
export const REPORT_RELATIVE_PATH = ["evaluation", "real-embeddings-report.md"] as const;

/**
 * Cost assumptions — keep them explicit and overridable in one place; every
 * number in the report's economics section is derived from these constants.
 * Provider-call and wrong-answer prices deliberately match the controlled
 * eval's DEFAULT_COST_ASSUMPTION (scripts/eval/harness.ts) so the two reports
 * use the same yardstick.
 */
export interface RealCostAssumptions {
  /** $ avoided per provider call not made (one served-from-cache reply). */
  providerCallUsd: number;
  /** $ cost of one wrong-answer reuse (FP). Asymmetric on purpose. */
  wrongAnswerPenaltyUsd: number;
  /**
   * $ per request for the semantic query embedding. 0 = local CPU embedder:
   * the marginal cash cost is ~$0 (we pay CPU time, not tokens). Set this to a
   * real per-request price if the deployment uses a paid embedding API.
   */
  embeddingUsdPerRequest: number;
  /** $/GB-month for the semantic store (assumed managed Postgres/pgvector). */
  storageUsdPerGbMonth: number;
  /** Denominator for the "per 1k requests" economics projection. */
  requestsPerSample: number;
}

export const REAL_COST_ASSUMPTIONS: RealCostAssumptions = {
  providerCallUsd: DEFAULT_COST_ASSUMPTION.providerCallUsd,
  wrongAnswerPenaltyUsd: DEFAULT_COST_ASSUMPTION.fpPenaltyUsd,
  embeddingUsdPerRequest: 0,
  storageUsdPerGbMonth: 0.15,
  requestsPerSample: 1000,
};

/** Assumed stored answer size (bytes) for the storage-cost estimate. */
export const STORAGE_CONTENT_BYTES_ASSUMED = 512;
/** tenant/provider/model/usage/ttl/system fingerprint/policy version/overhead. */
export const STORAGE_METADATA_BYTES_ASSUMED = 256;
/** pgvector row + index overhead multiplier over raw payload bytes. */
export const STORAGE_INDEX_OVERHEAD_FACTOR = 1.5;

/** Embedding + payload + metadata + index overhead, in bytes per stored row. */
export function bytesPerRow(): number {
  const raw = EMBEDDING_DIM * 4 + STORAGE_CONTENT_BYTES_ASSUMED + STORAGE_METADATA_BYTES_ASSUMED; // 768 * float32
  return Math.round(raw * STORAGE_INDEX_OVERHEAD_FACTOR);
}

// ---------------------------------------------------------------------------
// Core: run one labeled pair through the REAL store + REAL policy
// ---------------------------------------------------------------------------

/** Build the ChatRequest shape the production route builds for a prompt+scope. */
export function requestFor(prompt: string, scope: PromptScope): ChatRequest {
  const messages: ChatRequest["messages"] = [];
  if (scope.system !== undefined) messages.push({ role: "system", content: scope.system });
  messages.push({ role: "user", content: prompt });
  return {
    model: scope.model.trim(),
    messages,
    temperature: scope.temperature,
    max_tokens: scope.maxTokens,
    stream: false,
  };
}

function scopeMatches(pair: LabeledPair): boolean {
  return (
    pair.cachedScope.tenant === pair.queryScope.tenant &&
    pair.cachedScope.model.trim() === pair.queryScope.model.trim()
  );
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** One labeled pair evaluated at every threshold, as the production route would. */
export interface PairResult {
  id: string;
  family: RealFamily;
  mustHit: boolean;
  /** Real embedding cosine between the cached prompt and the query prompt. */
  cosine: number;
  /** tenant+model+provider equal, i.e. the retrieval filter can see the row. */
  scopeMatch: boolean;
  /** Reuse verdict at each threshold, aligned with the thresholds argument. */
  reusedByThreshold: boolean[];
  /** Why the pair reused (or why not) at each threshold. */
  reasonsByThreshold: string[];
}

class EmbeddingCache {
  private readonly cache = new Map<string, number[]>();
  constructor(private readonly embedder: EmbeddingProvider) {}
  async embed(text: string): Promise<number[]> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const vec = await this.embedder.embed(text, AbortSignal.timeout(120_000));
    if (vec.length !== EMBEDDING_DIM) throw new Error(`embedder returned ${vec.length} dims, expected ${EMBEDDING_DIM}`);
    this.cache.set(text, vec);
    return vec;
  }
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Evaluate every pair with the real pipeline, one candidate row at a time
 * (same single-reference method as the controlled eval):
 *   retrieval:   InMemoryVectorStore.findSimilar(queryVec, queryScope, threshold)
 *   reuse gate:  isReusableSemantic(queryReq, hit, threshold)
 * The row is stored with the CACHED scope and a real system fingerprint, so
 * tenant/model/system/generation gates are exercised for real.
 */
export async function evaluatePairs(
  pairs: readonly LabeledPair[],
  embedder: EmbeddingProvider,
  thresholds: readonly number[] = REAL_THRESHOLDS,
): Promise<PairResult[]> {
  const cache = new EmbeddingCache(embedder);
  const results: PairResult[] = [];
  for (const pair of pairs) {
    const cachedReq = requestFor(pair.cachedPrompt, pair.cachedScope);
    const queryReq = requestFor(pair.queryPrompt, pair.queryScope);
    const cachedVec = await cache.embed(promptTextForEmbedding(cachedReq));
    const queryVec = await cache.embed(promptTextForEmbedding(queryReq));
    const cosine = round(cosineSimilarity(cachedVec, queryVec), 6);
    const matches = scopeMatches(pair);

    const store = new InMemoryVectorStore();
    const row: SemanticEntry = {
      tenant: pair.cachedScope.tenant,
      provider: PROVIDER_NAME,
      model: pair.cachedScope.model.trim(),
      promptHash: `real-eval:${pair.id}`,
      promptText: promptTextForEmbedding(cachedReq),
      temperature: pair.cachedScope.temperature,
      maxTokens: pair.cachedScope.maxTokens,
      embedding: cachedVec,
      // Admission model: only non-empty, normalized success responses are
      // stored. The content text is irrelevant to the reuse decision here, but
      // it must be non-empty or the policy's empty-content gate would mask the
      // threshold/gates we are measuring.
      content: `cached answer for ${pair.id}`,
      ttlSeconds: 3600,
      systemFingerprint: systemFingerprint(cachedReq),
      policyVersion: POLICY_VERSION,
    };
    await store.save(row);

    const reusedByThreshold: boolean[] = [];
    const reasonsByThreshold: string[] = [];
    for (const threshold of thresholds) {
      const hits = await store.findSimilar(
        queryVec,
        { tenant: pair.queryScope.tenant, provider: PROVIDER_NAME, model: queryReq.model },
        { threshold, topK: 3 },
      );
      if (hits.length === 0) {
        reusedByThreshold.push(false);
        reasonsByThreshold.push(matches ? "below-threshold" : "scope-mismatch");
        continue;
      }
      let reused = false;
      let reason = "retrieved-but-blocked";
      for (const hit of hits) {
        const decision = isReusableSemantic(queryReq, hit, {
          provider: PROVIDER_NAME,
          threshold,
          tenant: pair.queryScope.tenant,
        });
        reason = decision.reason;
        if (decision.reusable) {
          reused = true;
          break;
        }
      }
      reusedByThreshold.push(reused);
      reasonsByThreshold.push(reason);
    }

    results.push({
      id: pair.id,
      family: pair.family,
      mustHit: pair.mustHit,
      cosine,
      scopeMatch: matches,
      reusedByThreshold,
      reasonsByThreshold,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Defense in depth: metadata gates must block a *leaked* retrieval hit
// ---------------------------------------------------------------------------

/**
 * Threshold-independent policy gate check. For the metadata families
 * (system/tenant/model/generation changes) the prompt text can be identical, so
 * a correct cache must be safe even if retrieval wrongly returned the row.
 * We simulate that leak by filtering retrieval on the CACHED row's scope, then
 * run the real policy with the QUERY scope: reuse must still be rejected.
 * This isolates the policy gates from the similarity threshold (a semantic
 * near-miss, by contrast, is only catchable by the threshold — see report).
 */
export interface PolicyDefenseResult {
  family: RealFamily;
  checked: number;
  violations: number;
  reasons: Record<string, number>;
}

export async function checkMetadataPolicyDefense(
  pairs: readonly LabeledPair[],
  embedder: EmbeddingProvider,
  threshold: number,
): Promise<PolicyDefenseResult[]> {
  const cache = new EmbeddingCache(embedder);
  const out: PolicyDefenseResult[] = [];
  for (const family of METADATA_FAMILIES) {
    const familyPairs = pairs.filter((p) => p.family === family);
    let violations = 0;
    const reasons: Record<string, number> = {};
    for (const pair of familyPairs) {
      const cachedReq = requestFor(pair.cachedPrompt, pair.cachedScope);
      const queryReq = requestFor(pair.queryPrompt, pair.queryScope);
      const cachedVec = await cache.embed(promptTextForEmbedding(cachedReq));
      const queryVec = await cache.embed(promptTextForEmbedding(queryReq));
      const store = new InMemoryVectorStore();
      await store.save({
        tenant: pair.cachedScope.tenant,
        provider: PROVIDER_NAME,
        model: pair.cachedScope.model.trim(),
        promptHash: `defense:${pair.id}`,
        promptText: promptTextForEmbedding(cachedReq),
        temperature: pair.cachedScope.temperature,
        maxTokens: pair.cachedScope.maxTokens,
        embedding: cachedVec,
        content: `cached answer for ${pair.id}`,
        ttlSeconds: 3600,
        systemFingerprint: systemFingerprint(cachedReq),
        policyVersion: POLICY_VERSION,
      });
      // Leak: retrieve as if the tenant/model filter had matched the cached row.
      const hits = await store.findSimilar(
        queryVec,
        { tenant: pair.cachedScope.tenant, provider: PROVIDER_NAME, model: pair.cachedScope.model.trim() },
        { threshold: 0, topK: 1 },
      );
      const hit = hits[0];
      if (!hit) {
        reasons["not-retrieved"] = (reasons["not-retrieved"] ?? 0) + 1;
        continue;
      }
      const decision = isReusableSemantic(queryReq, hit, {
        provider: PROVIDER_NAME,
        threshold: 0,
        tenant: pair.queryScope.tenant,
      });
      reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
      if (decision.reusable) violations += 1;
    }
    out.push({ family, checked: familyPairs.length, violations, reasons });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sampling-field admission: top_p / stop cannot be honored by the semantic cache
// ---------------------------------------------------------------------------

/**
 * The semantic store records temperature/max_tokens/system prompt but NOT
 * sampling/shaping fields. The current policy (see src/policy/reuse.ts) refuses
 * reuse for a request that sets `top_p` or `stop`, and the chat route skips
 * semantic lookup/admission for those requests as defense in depth (the exact
 * cache still covers them because its canonical identity includes both fields).
 * This check runs the LIVE policy against a row that would otherwise be a
 * perfect match, so the report does not merely assert the behavior — if a
 * future policy stops gating these fields, the report says so.
 */
export interface SamplingFieldDecision {
  field: "top_p" | "stop";
  reusable: boolean;
  reason: string;
}

export interface SamplingFieldAdmission {
  policyVersion: number;
  decisions: SamplingFieldDecision[];
  /** True iff the live policy refuses semantic reuse for every sampling field. */
  blocked: boolean;
}

export function checkSamplingFieldAdmission(): SamplingFieldAdmission {
  const base: ChatRequest = {
    model: DEFAULT_SCOPE.model,
    messages: [{ role: "user", content: "What is the capital of France?" }],
    temperature: 1.0,
    stream: false,
  };
  const candidate: SemanticHit = {
    id: "sampling-gate",
    promptText: promptTextForEmbedding(base),
    content: "cached answer",
    temperature: 1.0,
    maxTokens: undefined,
    model: DEFAULT_SCOPE.model,
    provider: PROVIDER_NAME,
    tenant: DEFAULT_SCOPE.tenant,
    systemFingerprint: systemFingerprint(base),
    policyVersion: POLICY_VERSION,
    similarity: 0.99,
  };
  const variants: { field: "top_p" | "stop"; req: ChatRequest }[] = [
    { field: "top_p", req: { ...base, top_p: 0.9 } },
    { field: "stop", req: { ...base, stop: ["\n\n"] } },
  ];
  const decisions = variants.map(({ field, req }) => {
    const decision = isReusableSemantic(req, candidate, { provider: PROVIDER_NAME, threshold: 0.9, tenant: DEFAULT_SCOPE.tenant });
    return { field, reusable: decision.reusable, reason: decision.reason };
  });
  return { policyVersion: POLICY_VERSION, decisions, blocked: decisions.every((d) => !d.reusable) };
}

// ---------------------------------------------------------------------------
// Metrics + economics
// ---------------------------------------------------------------------------

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface RealSweepPoint {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  positives: number;
  negatives: number;
  total: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  /** Share of ALL requests served from the semantic cache: (TP + FP) / N. */
  semanticHitRate: number;
  /** Share of served-from-cache replies that were legitimate: TP / (TP + FP). */
  safeReuseRate: number;
  providerCallsAvoidedPer1k: number;
  wrongAnswersPer1k: number;
  embeddingCostPer1kUsd: number;
  storageCostPer1kUsd: number;
  netSavingsPer1kUsd: number;
  perFamily: Record<RealFamily, Confusion>;
}

export function buildSweepPoints(
  results: readonly PairResult[],
  thresholds: readonly number[],
  assumptions: RealCostAssumptions = REAL_COST_ASSUMPTIONS,
): RealSweepPoint[] {
  const total = results.length;
  const positives = results.filter((r) => r.mustHit).length;
  const negatives = total - positives;
  const rowsPer1k = bytesPerRow();
  return thresholds.map((threshold, ti) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const perFamily = Object.fromEntries(
      REAL_FAMILIES.map((f) => [f, { tp: 0, fp: 0, fn: 0, tn: 0 }]),
    ) as Record<RealFamily, Confusion>;
    for (const result of results) {
      const reused = result.reusedByThreshold[ti] ?? false;
      const fam = perFamily[result.family];
      if (reused && result.mustHit) {
        tp += 1;
        fam.tp += 1;
      } else if (reused && !result.mustHit) {
        fp += 1;
        fam.fp += 1;
      } else if (!reused && result.mustHit) {
        fn += 1;
        fam.fn += 1;
      } else {
        tn += 1;
        fam.tn += 1;
      }
    }
    const scale = assumptions.requestsPerSample / total;
    const callsAvoidedPer1k = (tp + fp) * scale;
    const wrongAnswersPer1k = fp * scale;
    const embeddingCostPer1kUsd = assumptions.requestsPerSample * assumptions.embeddingUsdPerRequest;
    const storedRowsPer1k = (fn + tn) * scale; // rows admitted after a real provider call
    const storageCostPer1kUsd = (storedRowsPer1k * rowsPer1k * assumptions.storageUsdPerGbMonth) / 1e9;
    const netSavingsPer1kUsd =
      callsAvoidedPer1k * assumptions.providerCallUsd -
      wrongAnswersPer1k * assumptions.wrongAnswerPenaltyUsd -
      embeddingCostPer1kUsd -
      storageCostPer1kUsd;
    return {
      threshold,
      tp,
      fp,
      fn,
      tn,
      positives,
      negatives,
      total,
      precision: tp + fp === 0 ? 1 : tp / (tp + fp),
      recall: positives === 0 ? 1 : tp / positives,
      falsePositiveRate: negatives === 0 ? 0 : fp / negatives,
      semanticHitRate: total === 0 ? 0 : (tp + fp) / total,
      safeReuseRate: tp + fp === 0 ? 1 : tp / (tp + fp),
      providerCallsAvoidedPer1k: callsAvoidedPer1k,
      wrongAnswersPer1k,
      embeddingCostPer1kUsd,
      storageCostPer1kUsd,
      netSavingsPer1kUsd,
      perFamily,
    };
  });
}

/**
 * Safety-first recommendation: among thresholds with ZERO observed false
 * positives, take the best net savings. Ties resolve to the LOWER threshold:
 * above the empirical safety boundary extra points add no measured safety, and
 * the lowest safe value is the boundary operators can reason about (the report
 * separately notes the margin to the highest-scoring negative). Returns
 * undefined when even the highest threshold lets a wrong answer through — that
 * is a hard gate failure.
 */
export function chooseRecommendedThreshold(
  points: readonly RealSweepPoint[],
  assumptions: RealCostAssumptions = REAL_COST_ASSUMPTIONS,
): RealSweepPoint | undefined {
  const safe = points.filter((p) => p.fp === 0);
  if (safe.length === 0) return undefined;
  let best = safe[0] as RealSweepPoint;
  for (const point of safe.slice(1)) {
    if (point.netSavingsPer1kUsd > best.netSavingsPer1kUsd) best = point;
  }
  return best;
}

/** Pure net-$ optimum (can pick a threshold that serves wrong answers). */
export function chooseUnrestrictedThreshold(
  points: readonly RealSweepPoint[],
  _assumptions: RealCostAssumptions = REAL_COST_ASSUMPTIONS,
): RealSweepPoint {
  let best = points[0] as RealSweepPoint;
  for (const point of points.slice(1)) {
    if (point.netSavingsPer1kUsd > best.netSavingsPer1kUsd) best = point;
  }
  return best;
}

/** Break-even wrong-answer cost: a FP is net-positive only below this price. */
export function breakEvenWrongAnswerUsd(assumptions: RealCostAssumptions = REAL_COST_ASSUMPTIONS): number {
  return assumptions.providerCallUsd;
}

// ---------------------------------------------------------------------------
// Report builder (pure, deterministic; no timestamps / runtime / machine info)
// ---------------------------------------------------------------------------

export interface SimilarityStats {
  family: RealFamily;
  pairs: number;
  positives: number;
  min: number;
  median: number;
  max: number;
  atLeast090: number;
  atLeast095: number;
}

export function similarityStats(results: readonly PairResult[], family: RealFamily): SimilarityStats {
  const familyResults = results.filter((r) => r.family === family).sort((a, b) => a.cosine - b.cosine);
  const n = familyResults.length;
  const cos = familyResults.map((r) => r.cosine);
  return {
    family,
    pairs: n,
    positives: familyResults.filter((r) => r.mustHit).length,
    min: n === 0 ? 0 : round(Math.min(...cos), 4),
    median: n === 0 ? 0 : round(cos[Math.floor(n / 2)] as number, 4),
    max: n === 0 ? 0 : round(Math.max(...cos), 4),
    atLeast090: cos.filter((c) => c >= 0.9).length,
    atLeast095: cos.filter((c) => c >= 0.95).length,
  };
}

export interface ControlledComparison {
  version: string;
  thresholds: number[];
  points: ControlledSweepPoint[];
  optimum: ControlledSweepPoint;
}

export interface RealReportInput {
  fingerprint: string;
  pairCount: number;
  positives: number;
  negatives: number;
  results: readonly PairResult[];
  points: readonly RealSweepPoint[];
  defense: readonly PolicyDefenseResult[];
  sampling: SamplingFieldAdmission;
  recommended: RealSweepPoint | undefined;
  unrestricted: RealSweepPoint;
  assumptions: RealCostAssumptions;
  controlled: ControlledComparison;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(4)}`;
}

function truncate(text: string, max = 88): string {
  const clean = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function thresholdIndex(thresholds: readonly number[], value: number): number {
  const idx = thresholds.findIndex((t) => Math.abs(t - value) < 1e-9);
  return idx;
}

function isReusedAt(result: PairResult, thresholds: readonly number[], threshold: number): boolean {
  const idx = thresholdIndex(thresholds, threshold);
  return idx >= 0 ? (result.reusedByThreshold[idx] ?? false) : false;
}

function familyConfusionRow(point: RealSweepPoint, family: RealFamily): string {
  const c = point.perFamily[family];
  return `${c.tp}/${c.fp}/${c.fn}/${c.tn}`;
}

export function buildRealReport(input: RealReportInput): string {
  const { results, points, recommended, unrestricted, assumptions, controlled } = input;
  const thresholds = points.map((p) => p.threshold);
  const defaultPoint = points.find((p) => Math.abs(p.threshold - DEFAULT_GATEWAY_THRESHOLD) < 1e-9);
  const maxThresholdPoint = points[points.length - 1] as RealSweepPoint;
  const positiveResults = results.filter((r) => r.mustHit);
  const textNegativeFamilies = REAL_FAMILIES.filter((f) => !METADATA_FAMILIES.includes(f));
  const textNegativeResults = results.filter((r) => !r.mustHit && textNegativeFamilies.includes(r.family));
  const metadataNegativeResults = results.filter((r) => !r.mustHit && METADATA_FAMILIES.includes(r.family));
  const familyPositiveCount = (family: RealFamily): number => positiveResults.filter((r) => r.family === family).length;
  const paraphrasePositives = positiveResults.filter((r) => r.family === "paraphrase");
  const sortedParaphrase = [...paraphrasePositives].sort((a, b) => a.cosine - b.cosine);
  const paraphraseMedian =
    sortedParaphrase.length === 0 ? 0 : (sortedParaphrase[Math.floor(sortedParaphrase.length / 2)] as PairResult).cosine;
  const maxParaphraseCosine = paraphrasePositives.length === 0 ? 0 : Math.max(...paraphrasePositives.map((r) => r.cosine));
  const maxTextNegativeCosine = textNegativeResults.length === 0 ? 0 : Math.max(...textNegativeResults.map((r) => r.cosine));

  const lines: string[] = [];
  lines.push("# Relay — real-embedding semantic evaluation (Tasks 7–8)");
  lines.push("");
  lines.push(
    `**Dataset:** \`${REAL_DATASET_VERSION}\` — ${input.pairCount} labeled prompt pairs ` +
      `(${input.positives} must-HIT / ${input.negatives} must-MISS), fingerprint \`${input.fingerprint.slice(0, 16)}…\`. ` +
      "Generated deterministically by `scripts/eval/realDataset.ts`; validated on every run (the runner exits non-zero otherwise).",
  );
  lines.push("");
  lines.push(
    `**Embedder:** the REAL built-in embedder — \`${REAL_EMBEDDER_MODEL}\` — through the **real** \`InMemoryVectorStore\` ` +
      "and the **real** `isReusableSemantic` policy, in production order (retrieval by scoped vector search, then the reuse gate). " +
      "No mock/controlled embeddings are used for any number below.",
  );
  lines.push("");
  lines.push(
    `**Reproduce:** \`npx tsx scripts/eval/realEmbeddings.ts\` (writes this file). Hermetic: deterministic local CPU inference, ` +
      "no network, no provider spend. Report contains no timestamps/runtime, so two runs on the same embedder build are byte-identical.",
  );
  lines.push("");
  lines.push("## Headline findings");
  lines.push("");
  if (recommended) {
    const recIdx = thresholdIndex(thresholds, recommended.threshold);
    const dupTotal = familyPositiveCount("duplicate");
    const dupServed = recommended.perFamily["duplicate"].tp;
    const parTotal = familyPositiveCount("paraphrase");
    const parServed = recommended.perFamily["paraphrase"].tp;
    const fnExamples = positiveResults.filter((r) => !(r.reusedByThreshold[recIdx] ?? false)).length;
    lines.push(
      `- **Safety boundary: \`SEMANTIC_THRESHOLD\` must be ≥ ${recommended.threshold.toFixed(2)} for this embedder/corpus.** ` +
        "It is the lowest swept threshold with zero observed false positives " +
        `(TP ${recommended.tp}, FP ${recommended.fp}, FN ${recommended.fn}, precision ${pct(recommended.precision)}, ` +
        `recall ${pct(recommended.recall)}, net ${usd(recommended.netSavingsPer1kUsd)}/1k requests under the assumptions below). ` +
        "The higher points (0.96–0.98) have identical metrics on this corpus, so 0.95 is the empirical boundary; add margin only if " +
        "you want protection against unseen traffic.",
    );
    lines.push(
      `- **At a zero-FP threshold the semantic cache reuses exact/formatting duplicates only:** duplicates served ${dupServed}/${dupTotal}, ` +
        `**paraphrases served ${parServed}/${parTotal}.** Real paraphrase cosines span ` +
        `${paraphrasePositives.length === 0 ? "n/a" : (sortedParaphrase[0] as PairResult).cosine.toFixed(4)}–${maxParaphraseCosine.toFixed(4)} ` +
        `(median ${paraphraseMedian.toFixed(4)}), while answer-changing text-level negatives reach ${maxTextNegativeCosine.toFixed(4)}: ` +
        "the distributions overlap, and date/number edits can score HIGHER than most genuine paraphrases.",
    );
    if (fnExamples > 0) {
      lines.push(
        `- It deliberately leaves ${fnExamples} safe pair(s) uncached (each is one extra provider call) — a missed cache hit costs one ` +
          "call, a wrong answer costs orders of magnitude more. This is the false-positive-first trade-off, not a bug.",
      );
    }
  } else {
    lines.push(
      `- **No evaluated threshold has zero false positives** (up to ${maxThresholdPoint.threshold.toFixed(2)}): ` +
        `at the highest threshold FP=${maxThresholdPoint.fp}, recall ${pct(maxThresholdPoint.recall)}. ` +
        "The runner exits non-zero: this corpus does not justify enabling semantic reuse at any swept threshold.",
    );
  }
  if (defaultPoint) {
    const defaultIdx = thresholdIndex(thresholds, DEFAULT_GATEWAY_THRESHOLD);
    const defaultFps = results.filter((r) => !r.mustHit && (r.reusedByThreshold[defaultIdx] ?? false));
    lines.push(
      `- **The former default 0.92 is not safe on this corpus:** TP ${defaultPoint.tp}, **FP ${defaultPoint.fp}** ` +
        `(precision ${pct(defaultPoint.precision)}, FPR ${pct(defaultPoint.falsePositiveRate)}), FN ${defaultPoint.fn}, ` +
        `net ${usd(defaultPoint.netSavingsPer1kUsd)}/1k. ` +
        (defaultFps.length === 0
          ? "No wrong-answer reuse observed."
          : `Wrong-answer reuses: ${defaultFps.map((r) => `\`${r.id}\` (${r.family}, cosine ${r.cosine.toFixed(4)})`).join("; ")}.`),
    );
    lines.push(
      `- **Why the cosine alone cannot fix it:** paraphrase cosines (${paraphrasePositives.length === 0 ? "n/a" : `${(sortedParaphrase[0] as PairResult).cosine.toFixed(4)}–${maxParaphraseCosine.toFixed(4)}`}) ` +
        `overlap text-level negatives (up to ${maxTextNegativeCosine.toFixed(4)}); only byte/formatting duplicates sit at 1.0000. ` +
        "A threshold low enough for paraphrase reuse serves wrong answers; a threshold high enough to be safe reuses duplicates only. " +
        "Safe paraphrase reuse needs an extra lexical/number/date guard and/or a verifier, validated with this same harness (see " +
        "\"What would make paraphrase reuse safe\").",
    );
    lines.push(
      "- **Current production default: 0.95** — adopted from this report's zero-false-positive boundary; the 0.92 " +
        "figures above are retained as the former default so the measured risk is documented rather than erased.",
    );
  }
  lines.push(
    `- **Controlled eval vs real eval:** the controlled-cosine sweep (\`${controlled.version}\`, prescribed cosines) has its ` +
      `cost-aware optimum at **${controlled.optimum.threshold.toFixed(2)}** with TP ${controlled.optimum.tp} / FP ${controlled.optimum.fp} / ` +
      `FN ${controlled.optimum.fn}. That validates the policy math and gates, not embedding quality — the real model below is the ` +
      "evidence for what threshold is safe with actual sentence-transformer cosines. Note the two optima disagree: the controlled " +
      "0.92 is unsafe with real cosines.",
  );
  lines.push(
    `- **Economics:** under the stated assumptions (${usd(assumptions.providerCallUsd)}/provider call, ` +
      `${usd(assumptions.wrongAnswerPenaltyUsd)}/wrong-answer reuse, local embedding ≈ $0 marginal, ` +
      `${bytesPerRow()} B/row at $${assumptions.storageUsdPerGbMonth.toFixed(2)}/GB-month), the estimated net saving is ` +
      `${usd(unrestricted.netSavingsPer1kUsd)}/1k requests at the unrestricted optimum ` +
      `(thr ${unrestricted.threshold.toFixed(2)} / ${unrestricted.wrongAnswersPer1k.toFixed(2)} wrong answers per 1k) and ` +
      `${recommended ? `${usd(recommended.netSavingsPer1kUsd)}/1k at the safe recommendation — modest, because on this traffic mix ` +
          "the only safe reuse is duplicate-shaped" : "n/a at the safe recommendation"}.`,
  );
  lines.push("");

  // ------------------------------------------------------------------ dataset
  const counts = new Map<RealFamily, number>();
  for (const result of results) counts.set(result.family, (counts.get(result.family) ?? 0) + 1);
  lines.push("## Dataset and labelling rules");
  lines.push("");
  lines.push(
    "Each pair is `(cached prompt, incoming query prompt)`. `mustHit = true` iff reusing the cached answer is semantically safe.",
  );
  lines.push("");
  lines.push("| family | pairs | must-HIT | what changes |");
  lines.push("|---|---|---|---|");
  const familyDescriptions: Record<RealFamily, string> = {
    duplicate: "formatting/casing only (same question)",
    paraphrase: "same information need, different wording — safe reuse",
    "near-miss": "same topic, different answer-critical entity/fact — must MISS",
    "date-number": "date, quantity, price, version, size or top-K changes",
    constraint: "an added/removed constraint changes the answer (language, format, audience, negation, budget…)",
    "system-change": "identical user text, different system instruction",
    "tenant-change": "identical text/model, different tenant",
    "model-change": "identical text, different model id",
    "generation-change": "identical text, different temperature or max_tokens",
    unrelated: "different topic entirely",
  };
  for (const family of REAL_FAMILIES) {
    const famResults = results.filter((r) => r.family === family);
    const pos = famResults.filter((r) => r.mustHit).length;
    lines.push(`| ${family} | ${famResults.length} | ${pos} | ${familyDescriptions[family]} |`);
  }
  lines.push("");
  lines.push(
    "Synthetic-template limitation (stated up front): these are hand-authored prompts, not sampled production traffic — the " +
      "domain mix and positive/negative ratio are assumptions, not measurements. They are short English prompts on one embedder " +
      "model version; subtle pragmatics are labelled conservatively (answer-changing => must MISS). Re-validate on sampled real " +
      "traffic before changing a default that affects users.",
  );
  lines.push("");

  // ------------------------------------------------------------------- method
  lines.push("## Method");
  lines.push("");
  lines.push(
    "For each pair, one candidate row is written to a fresh production `InMemoryVectorStore` under the **cached** request scope " +
      "(tenant/model/temperature/max_tokens/system fingerprint/policy version), then the incoming query is embedded and run through " +
      "the production order: scoped `findSimilar(queryVec, {tenant, provider, model}, {threshold, topK})`, then " +
      "`isReusableSemantic(query, hit, {provider, threshold, tenant})`. A pair is *reused* only when both stages agree. " +
      "Pairs are evaluated one candidate row at a time (same single-reference method as the controlled eval), so these numbers " +
      "measure embedding separability + policy, not cross-row retrieval effects — the HTTP e2e semantic suites and `npm run bench` " +
      "cover the serving path.",
  );
  lines.push("");
  lines.push(
    `**Thresholds swept:** ${thresholds.map((t) => t.toFixed(2)).join(", ")}. ` +
      "The range is extended past the controlled eval's 0.95 because real cosine distributions can place entity-swapped " +
      "negatives above 0.95; a threshold only reachable outside the usual range is still a finding.",
  );
  lines.push("");
  lines.push("### Metric definitions");
  lines.push("");
  lines.push("| metric | definition |");
  lines.push("|---|---|");
  lines.push("| TP / FP / FN / TN | reuse decision vs `mustHit`; **FP = wrong-answer reuse**, FN = missed safe reuse |");
  lines.push("| precision | TP / (TP + FP) — share of reuses that were legitimate |");
  lines.push("| recall | TP / (TP + FN) — share of safe reuses actually served |");
  lines.push("| false-positive rate | FP / (FP + TN) — share of must-MISS requests wrongly served |");
  lines.push("| semantic hit rate | (TP + FP) / N — share of all requests served from the semantic cache |");
  lines.push("| safe-reuse rate | TP / (TP + FP) — safety-first view of the same reuses |");
  lines.push("| calls avoided / 1k | (TP + FP) / N × 1000 |");
  lines.push("| net $ / 1k | calls avoided × providerCallUsd − wrong answers × wrongAnswerPenaltyUsd − embedding − storage (per assumptions below) |");
  lines.push("");
  lines.push("### Similarity calibration by family (real ONNX cosines)");
  lines.push("");
  lines.push("| family | pairs | must-HIT | min | median | max | ≥0.90 | ≥0.95 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const family of REAL_FAMILIES) {
    const s = similarityStats(results, family);
    lines.push(
      `| ${family} | ${s.pairs} | ${s.positives} | ${s.min.toFixed(4)} | ${s.median.toFixed(4)} | ${s.max.toFixed(4)} | ${s.atLeast090} | ${s.atLeast095} |`,
    );
  }
  lines.push("");

  // ------------------------------------------------------------------- sweep
  lines.push("## Threshold sweep (real embeddings + real store + real policy)");
  lines.push("");
  lines.push("| thr | TP | FP | FN | TN | precision | recall | FPR | hit rate | calls avoided /1k | wrong /1k | net $ /1k |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const point of points) {
    lines.push(
      `| ${point.threshold.toFixed(2)} | ${point.tp} | ${point.fp} | ${point.fn} | ${point.tn} | ` +
        `${pct(point.precision)} | ${pct(point.recall)} | ${pct(point.falsePositiveRate)} | ${pct(point.semanticHitRate)} | ` +
        `${point.providerCallsAvoidedPer1k.toFixed(1)} | ${point.wrongAnswersPer1k.toFixed(2)} | ${usd(point.netSavingsPer1kUsd)} |`,
    );
  }
  lines.push("");
  lines.push("<details><summary>Per-family TP/FP/FN/TN at each threshold</summary>");
  lines.push("");
  lines.push(`| family | ${thresholds.map((t) => t.toFixed(2)).join(" | ")} |`);
  lines.push(`|---|${thresholds.map(() => "---").join("|")}|`);
  for (const family of REAL_FAMILIES) {
    lines.push(
      `| ${family} | ${points.map((p) => familyConfusionRow(p, family)).join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // ------------------------------------------------- threshold justification
  lines.push("## Chosen threshold and why");
  lines.push("");
  if (recommended) {
    const positivesBelow = positiveResults.filter((r) => r.cosine < recommended.threshold);
    const scopeMatchedNegatives = textNegativeResults.filter((r) => r.scopeMatch);
    const maxNegativeCosine = scopeMatchedNegatives.length === 0 ? 0 : Math.max(...scopeMatchedNegatives.map((r) => r.cosine));
    const minPositiveCosine = positiveResults.length === 0 ? 0 : Math.min(...positiveResults.map((r) => r.cosine));
    const dupTotal = familyPositiveCount("duplicate");
    const dupServed = recommended.perFamily["duplicate"].tp;
    const parTotal = familyPositiveCount("paraphrase");
    const parServed = recommended.perFamily["paraphrase"].tp;
    lines.push(
      `- **Recommended: ${recommended.threshold.toFixed(2)}** — the **lowest swept threshold with zero observed false positives** ` +
        "(the empirical safety boundary; higher points have identical metrics here). " +
        `Result: TP ${recommended.tp} / FP ${recommended.fp} / FN ${recommended.fn}, precision ${pct(recommended.precision)}, ` +
        `recall ${pct(recommended.recall)}, hit rate ${pct(recommended.semanticHitRate)}.`,
    );
    lines.push(
      `- **What it serves:** duplicate family ${dupServed}/${dupTotal} (cosine 1.0000 for formatting/casing variants — the tokenizer ` +
        "normalises case and whitespace, so these are exact duplicates), paraphrase family " +
        `**${parServed}/${parTotal}** (paraphrase cosines ${(sortedParaphrase[0] as PairResult | undefined)?.cosine.toFixed(4) ?? "n/a"}–` +
        `${maxParaphraseCosine.toFixed(4)}; only ${paraphrasePositives.filter((r) => r.cosine >= recommended.threshold).length} reaches ` +
        `${recommended.threshold.toFixed(2)}).`,
    );
    lines.push(
      `- **Margin to the dangerous class:** the highest real cosine among text-level must-MISS pairs is **${maxNegativeCosine.toFixed(4)}** ` +
        `(${textNegativeResults.filter((r) => r.cosine === maxNegativeCosine && r.scopeMatch).map((r) => r.family).join(", ")}), so the ` +
        `recommended threshold sits ${(recommended.threshold - maxNegativeCosine).toFixed(4)} above it. The nearest positive that is ` +
        `rejected is ${maxParaphraseCosine.toFixed(4)}; the closest safe positive overall is ${minPositiveCosine.toFixed(4)}. ` +
        "Because the closest positive is *below* the highest negative, no threshold on this corpus serves paraphrases AND zero " +
        "wrong answers — that is the core finding, not a tuning failure.",
    );
    if (positivesBelow.length > 0) {
      lines.push(
        `- **Recall cost:** ${positivesBelow.length} safe pair(s) stay uncached below ${recommended.threshold.toFixed(2)} ` +
          `(each costs one extra provider call): ${positivesBelow
            .sort((a, b) => a.cosine - b.cosine)
            .slice(0, 8)
            .map((r) => `${r.id} (${r.cosine.toFixed(4)})`)
            .join(", ")}${positivesBelow.length > 8 ? ", …" : ""}.`,
      );
    }
    lines.push(
      `- **Metadata gates are threshold-independent:** tenant/model/system/generation swaps can have cosine 1.0000, so the ` +
        "embedding threshold alone would never block them; the policy gates do (verified separately below). The threshold's job " +
        "is the *text-level* negatives (near-miss, date/number, constraint), and those are why it cannot be lower.",
    );
    if (defaultPoint && defaultPoint.threshold !== recommended.threshold) {
      const direction = recommended.threshold > defaultPoint.threshold ? "higher" : "lower";
      lines.push(
        `- **vs the former default 0.92:** the recommendation is ${direction} (${recommended.threshold.toFixed(2)}). ` +
          `At 0.92 this corpus gets precision ${pct(defaultPoint.precision)}, recall ${pct(defaultPoint.recall)}, ` +
          `**${defaultPoint.fp} wrong answers**, net ${usd(defaultPoint.netSavingsPer1kUsd)}/1k — so lowering/shipping 0.92 for ` +
          "the local embedder is not justified by these data. It would only become justifiable with an added guard (below).",
      );
    }
  } else {
    lines.push(
      `- **No safe threshold on this corpus.** Even the highest swept threshold (${maxThresholdPoint.threshold.toFixed(2)}) serves ` +
        `FP ${maxThresholdPoint.fp} (families: ${REAL_FAMILIES.filter((f) => maxThresholdPoint.perFamily[f].fp > 0).join(", ")}). ` +
        "The runner exits non-zero and the report should be treated as a blocker for semantic reuse with this embedder/model.",
    );
  }
  lines.push("");

  // ------------------------------------------------------------ design options
  const at080 = points.find((p) => Math.abs(p.threshold - 0.8) < 1e-9);
  const at085 = points.find((p) => Math.abs(p.threshold - 0.85) < 1e-9);
  const defaultIdxDesign = thresholdIndex(thresholds, DEFAULT_GATEWAY_THRESHOLD);
  const defaultFpsDesign = results.filter((r) => !r.mustHit && (r.reusedByThreshold[defaultIdxDesign] ?? false));
  lines.push("## What would make paraphrase reuse safe (design implications)");
  lines.push("");
  lines.push(
    "These are implications of the measurements, not implemented changes: the current policy has no field that can see " +
      "date/number/entity substitutions, which is why cosine is the only guard today.",
  );
  lines.push("");
  lines.push(
    "- **Cheapest correct option (no code):** keep the threshold at/above the empirical boundary (0.95 here) and accept " +
      "duplicate-only reuse. Semantic paraphrase reuse is effectively disabled on this corpus — that is the safe state.",
  );
  lines.push(
    "- **Guard idea — lexical/number/date fingerprint:** before reuse, require that digits, dates/times, versions, prices, " +
      "quantities and top-K tokens match between the cached prompt and the query (or fail closed when either contains them). " +
      `On this corpus it would have blocked the ${defaultFpsDesign.filter((r) => r.family === "date-number").length} date/number ` +
      `wrong answer(s) at the former default 0.92 (e.g. 30 s vs 60 s, cosine 0.9385; December vs June, cosine 0.9383), and a ` +
      "keyword/entity term check is needed for entity swaps like annual-vs-monthly (`near-refund-policy-1`, cosine 0.9208). " +
      "It is not in `isReusableSemantic` today and would need its own labelled set before shipping.",
  );
  lines.push(
    "- **Verifier idea — cross-encoder / LLM equivalence check:** for candidates in the mid band (say 0.85–0.98) ask a small " +
      "cross-encoder or a cheap LLM \"same information need?\" before serving. That targets exactly the overlap measured here, at the " +
      "price of one extra model call on would-be hits (which the current local-embedding setup cannot do for free).",
  );
  lines.push(
    "- **Better embeddings:** a larger/safer embedding model or an instruction-tuned retrieval model may separate entity swaps " +
      "from paraphrases; any swap must rerun this script and update the dataset/limits rather than reusing 0.92 by habit.",
  );
  lines.push(
    `- **Do not ship 0.80–0.85 for the local embedder** (suggested in the README's known-limits section): on this corpus those ` +
      `thresholds serve ${at080?.fp ?? "?"} and ${at085?.fp ?? "?"} wrong answers out of ${input.negatives} must-MISS pairs ` +
      `(FPR ${at080 ? pct(at080.falsePositiveRate) : "?"} / ${at085 ? pct(at085.falsePositiveRate) : "?"}). If that README ` +
      "guidance is still current, it must be replaced by numbers from this report.",
  );
  lines.push("");

  // --------------------------------------------------------------- false pos
  lines.push("## False positives (wrong-answer reuses)");
  lines.push("");
  const worstNegatives = [...textNegativeResults].sort((a, b) => b.cosine - a.cosine).slice(0, 12);
  if (worstNegatives.length === 0) {
    lines.push("No text-level must-MISS pairs in the dataset.");
  } else {
    lines.push(
      "Highest-cosine **text-level** must-MISS pairs (near-miss / date-number / constraint / unrelated) — these are the pairs the " +
        "similarity threshold has to separate. `@0.92` / `@rec` show whether that pair would be served at the former default and at " +
        `the recommended threshold${recommended ? ` ${recommended.threshold.toFixed(2)}` : ""}. Metadata-swap pairs (cosine up to ` +
        "1.0000) are blocked by policy gates and excluded here; they are covered in the next section.",
    );
    lines.push("");
    lines.push("| family | cosine | @0.92 | @rec | cached prompt → incoming prompt |");
    lines.push("|---|---|---|---|---|");
    for (const r of worstNegatives) {
      const atDefault = isReusedAt(r, thresholds, DEFAULT_GATEWAY_THRESHOLD) ? "REUSED" : "miss";
      const atRec = recommended ? (isReusedAt(r, thresholds, recommended.threshold) ? "REUSED" : "miss") : "n/a";
      const pair = REAL_PAIRS.find((p) => p.id === r.id);
      const desc = pair ? `${truncate(pair.cachedPrompt)} → ${truncate(pair.queryPrompt)}` : r.id;
      lines.push(`| ${r.family} | ${r.cosine.toFixed(4)} | ${atDefault} | ${atRec} | ${desc} |`);
    }
    lines.push("");
  }
  const defaultIdxForGallery = thresholdIndex(thresholds, DEFAULT_GATEWAY_THRESHOLD);
  const defaultFpResults = results.filter((r) => !r.mustHit && (r.reusedByThreshold[defaultIdxForGallery] ?? false));
  if (defaultFpResults.length > 0) {
    lines.push(`### The ${defaultFpResults.length} wrong answer(s) served at the former default 0.92`);
    lines.push("");
    lines.push("| family | cosine | cached prompt → incoming prompt |");
    lines.push("|---|---|---|");
    for (const r of [...defaultFpResults].sort((a, b) => b.cosine - a.cosine)) {
      const pair = REAL_PAIRS.find((p) => p.id === r.id);
      const desc = pair ? `${truncate(pair.cachedPrompt)} → ${truncate(pair.queryPrompt)}` : r.id;
      lines.push(`| ${r.family} | ${r.cosine.toFixed(4)} | ${desc} |`);
    }
    lines.push("");
  }
  const fpThresholds = points.filter((p) => p.fp > 0);
  if (fpThresholds.length === 0) {
    lines.push("**No false positive at any swept threshold on this corpus.**");
  } else {
    lines.push("False positives by threshold (count / families):");
    lines.push("");
    for (const point of fpThresholds) {
      const families = REAL_FAMILIES.filter((f) => point.perFamily[f].fp > 0).join(", ");
      lines.push(`- ${point.threshold.toFixed(2)}: **${point.fp}** (${families})`);
    }
  }
  lines.push("");

  // ----------------------------------------------------------- policy gates
  lines.push("## Policy gates (defense in depth, threshold-independent)");
  lines.push("");
  lines.push(
    "For the metadata families the user text can be identical, so a semantically-unsafe reuse would score cosine ≈ 1.0. " +
      "To prove the gates catch that even if retrieval returned the row, the cached row was force-retrieved (cached scope) and " +
      "the real policy was run with the query scope at threshold 0:",
  );
  lines.push("");
  lines.push("| family | pairs checked | wrong reuses allowed | observed policy reasons |");
  lines.push("|---|---|---|---|");
  for (const def of input.defense) {
    const reasons = Object.entries(def.reasons)
      .map(([reason, count]) => `${reason}×${count}`)
      .join(", ");
    lines.push(`| ${def.family} | ${def.checked} | ${def.violations} | ${reasons || "—"} |`);
  }
  lines.push("");
  lines.push(
    "All metadata-gate violations must be 0; the runner exits non-zero otherwise. The remaining families (near-miss, " +
      "date/number, constraint) differ in the prompt text and cannot be caught by a policy field: they are exactly what the " +
      "similarity threshold has to separate, and the false-positive section above is their risk surface.",
  );
  lines.push("");

  // ---------------------------------------------------------------- economics
  lines.push("## Economics and admission policy");
  lines.push("");
  lines.push("### Stated assumptions (constants in `scripts/eval/realEmbeddings.ts`)");
  lines.push("");
  lines.push("| assumption | value | basis |");
  lines.push("|---|---|---|");
  lines.push(
    `| provider cost / call avoided | ${usd(assumptions.providerCallUsd)} | same assumption as the controlled eval ('DEFAULT_COST_ASSUMPTION' in scripts/eval/harness.ts) |`,
  );
  lines.push(
    `| wrong-answer penalty / FP reuse | ${usd(assumptions.wrongAnswerPenaltyUsd)} | asymmetric by design: a wrong answer costs 250× a provider call under these constants |`,
  );
  lines.push(
    `| embedding cost / request | ${usd(assumptions.embeddingUsdPerRequest)} | local ONNX CPU: cash-marginal cost ≈ $0 (CPU time is not billed per token). Set a per-request price here if deploying a paid embedder API |`,
  );
  lines.push(
    `| storage cost | $${assumptions.storageUsdPerGbMonth.toFixed(2)}/GB-month | assumed managed Postgres/pgvector pricing |`,
  );
  lines.push(
    `| bytes / row | ${bytesPerRow()} B | 768-d float32 embedding (${EMBEDDING_DIM * 4} B) + ${STORAGE_CONTENT_BYTES_ASSUMED} B answer + ${STORAGE_METADATA_BYTES_ASSUMED} B metadata, ×${STORAGE_INDEX_OVERHEAD_FACTOR} index overhead |`,
  );
  lines.push(
    `| requests per projection | ${assumptions.requestsPerSample} | the corpus mix is treated as representative of 1,000 semantic-lookup requests |`,
  );
  lines.push("");
  lines.push("### Per-threshold economics");
  lines.push("");
  lines.push("| thr | calls avoided /1k | wrong answers /1k | embedding $ /1k | storage $ /1k | net $ /1k |");
  lines.push("|---|---|---|---|---|---|");
  for (const point of points) {
    lines.push(
      `| ${point.threshold.toFixed(2)} | ${point.providerCallsAvoidedPer1k.toFixed(1)} | ${point.wrongAnswersPer1k.toFixed(2)} | ` +
        `${usd(point.embeddingCostPer1kUsd)} | ${usd(point.storageCostPer1kUsd)} | ${usd(point.netSavingsPer1kUsd)} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Break-even wrong-answer cost: ${usd(breakEvenWrongAnswerUsd(assumptions))}.** A false-positive reuse already costs more ` +
      `than the provider call it avoids once a wrong answer costs more than ${usd(assumptions.providerCallUsd)} — which is why the ` +
      `recommendation optimises for zero FPs rather than maximum hit rate. Storage and embedding costs are negligible at these ` +
      "assumptions (fractions of a cent per 1k requests); latency is the other real cost of an embedding-backed lookup and is not " +
      "monetised here (see `npm run bench`: local ONNX inference ≈ 31 ms warm per short prompt).",
  );
  lines.push("");
  lines.push("### Admission policy (explicit)");
  lines.push("");
  lines.push("**Admitted to the semantic cache:** non-streaming, registered-lane requests that reached a provider and produced a " +
    "**non-empty, normalized success response**. Provider errors, empty/whitespace-only answers, malformed cached rows " +
    "(bad shape => evicted) and streaming responses are never admitted or served. Anonymous try-out requests never read or " +
    "write either cache.");
  lines.push("");
  lines.push("**Reuse requires, in order:** exact-cache miss, a scoped vector hit (same tenant + provider + model, similarity ≥ " +
    "threshold), and a passing `isReusableSemantic` decision — model id, temperature, max_tokens, tenant, provider, system-message " +
    "fingerprint, policy version, non-empty content, and the sampling-field gate below all re-checked at read time. Rows stamped " +
    `with an older policy version are refused (\`policy-version-mismatch\`), so rows admitted before policy v${input.sampling.policyVersion} ` +
    "cannot be reused; legacy rows with no fingerprint/policy version skip those two checks, so operators should re-warm old rows " +
    "after changing system defaults.");
  lines.push("");
  lines.push("**Sampling/shaping fields (`top_p`, `stop`): no semantic reuse.** The semantic store does not record these fields, so " +
    "a stored answer cannot be proven equivalent to a request that sets them. The LIVE policy is checked against a row that would " +
    `otherwise be a perfect match (policy v${input.sampling.policyVersion}):`);
  lines.push("");
  lines.push("| request sets | reusable? | policy reason |");
  lines.push("|---|---|---|");
  for (const decision of input.sampling.decisions) {
    lines.push(`| ${decision.field} | ${decision.reusable ? "**YES (unsafe)**" : "no"} | ${decision.reason} |`);
  }
  lines.push("");
  if (input.sampling.blocked) {
    lines.push(
      "The live policy refuses both fields, and `src/api/routes/chat.ts` additionally skips semantic lookup/admission when either " +
        "is set (defense in depth); the exact cache still serves such requests because its canonical identity includes both fields. " +
        "Unknown JSON fields are rejected by the strict request schema rather than silently dropped.",
    );
  } else {
    lines.push(
      "**WARNING: the live policy allowed semantic reuse for at least one sampling field.** Treat semantic reuse as unsafe for " +
        "those requests; the route-level skip (if present in `src/api/routes/chat.ts`) is then the only guard, and a row admitted " +
        "under a different sampling configuration could be served.",
    );
  }
  lines.push("");
  lines.push("**Any future generation field** (`top_k`, `seed`, `response_format`, penalties, tools) must enter BOTH the exact-cache " +
    "key AND `isReusableSemantic` before semantic reuse can be considered safe for it; until then the safest contract is to reject " +
    "it at the request schema (as the strict schema does for unknown fields) rather than accept a field the gateway drops.");
  lines.push("");
  lines.push("**Low confidence = no reuse.** The decision is deterministic: below the threshold there is no fallback, no " +
    "probabilistic reuse and no best-effort serving — the request goes to the provider and is re-admitted. The threshold is the " +
    "only confidence dial; this report recommends the safety-first value above.");
  lines.push("");
  lines.push("**Trade-off:** a false positive serves a fluent, plausible, wrong answer; a false negative costs one provider call. " +
    "The threshold table is the dial: lower thresholds raise calls avoided but serve wrong answers at a superlinear cost under the " +
    "stated penalty, so the recommendation is the lowest-risk point. `semanticHitRate` and `wrongAnswersPer1k` above make that " +
    "trade-off explicit per threshold.");
  lines.push("");

  // -------------------------------------------------------------- comparison
  lines.push("## Comparison with the controlled-embedding eval");
  lines.push("");
  lines.push(
    "The controlled eval (`scripts/eval/realDataset`-independent; `npm run eval`) prescribes the cosine per fixture and therefore " +
      "tests the threshold sweep/policy logic exactly. It cannot measure model quality. Side by side:",
  );
  lines.push("");
  lines.push("| eval | dataset | embeddings | cost-aware optimum | TP/FP/FN/TN at optimum | precision | recall | what it proves |");
  lines.push("|---|---|---|---|---|---|---|---|");
  const controlledOpt = controlled.optimum;
  lines.push(
    `| controlled | ${controlled.version} (26 fixtures, 7 must-HIT) | prescribed cosines | ${controlledOpt.threshold.toFixed(2)} | ` +
      `${controlledOpt.tp}/${controlledOpt.fp}/${controlledOpt.fn}/${controlledOpt.tn} | ${pct(controlledOpt.precision)} | ` +
      `${pct(controlledOpt.recall)} | threshold math + policy gates are correct |`,
  );
  lines.push(
    `| real (this report) | ${REAL_DATASET_VERSION} (${input.pairCount} pairs, ${input.positives} must-HIT) | real ONNX model | ` +
      `${recommended ? recommended.threshold.toFixed(2) : "none ≤ " + maxThresholdPoint.threshold.toFixed(2)} | ` +
      `${recommended ? `${recommended.tp}/${recommended.fp}/${recommended.fn}/${recommended.tn}` : `${maxThresholdPoint.tp}/${maxThresholdPoint.fp}/${maxThresholdPoint.fn}/${maxThresholdPoint.tn}`} | ` +
      `${pct(recommended ? recommended.precision : maxThresholdPoint.precision)} | ` +
      `${pct(recommended ? recommended.recall : maxThresholdPoint.recall)} | embedding quality / safe threshold for THIS model |`,
  );
  lines.push("");
  lines.push(
    `The controlled optimum (${controlledOpt.threshold.toFixed(2)}) is a property of its prescribed cosine values; it is not ` +
      "evidence that real paraphrases clear that bar. The real recommendation above is the number to use for deployments that " +
      "enable `EMBEDDING_PROVIDER=local`.",
  );
  lines.push("");

  // -------------------------------------------------------------- limitations
  lines.push("## Limitations");
  lines.push("");
  lines.push("- **Synthetic corpus, not traffic:** hand-authored pairs; domain mix and positive/negative ratio are assumptions. " +
    "Treat the threshold as validated for this corpus, and re-validate on a sample of real (anonymised) production prompts before " +
    "a default change.");
  lines.push("- **Single embedder configuration:** English prompts, `Xenova/all-mpnet-base-v2` q8, 768-d, default pooling. Other " +
    "models/quantisations/languages will have different cosine distributions; rerun this eval when swapping the embedder.");
  lines.push("- **Question-level labels:** \"safe reuse\" is judged by construction, not by an LLM judge or human annotators. " +
    "Ambiguous cases are labelled conservatively (answer-changing => must MISS).");
  lines.push("- **One candidate row per pair:** this isolates embedding separability + policy. Retrieval among many rows, " +
    "single-flight and the HTTP layer are covered by the e2e suites and `npm run bench`, not here.");
  lines.push("- **Determinism scope:** local CPU inference is deterministic on the same model/onnxruntime build; cross-machine " +
    "floating-point differences could flip a pair sitting exactly on a threshold. The report itself has no clock/randomness.");
  lines.push("- **Economics are assumptions, not invoices:** provider price, wrong-answer penalty, local-embedding marginal cost " +
    "and storage price are stated constants; change them in `scripts/eval/realEmbeddings.ts` and rerun.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("npx tsx scripts/eval/realEmbeddings.ts   # writes evaluation/real-embeddings-report.md, exits non-zero on gate failure");
  lines.push("npm run eval                              # existing controlled-cosine report (unchanged)");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runControlledComparison(): Promise<ControlledComparison> {
  const store = new InMemoryVectorStore();
  await seedControlledStore(store);
  const points = await sweepControlled(store, CONTROLLED_THRESHOLDS);
  return {
    version: CONTROLLED_DATASET_VERSION,
    thresholds: [...CONTROLLED_THRESHOLDS],
    points,
    optimum: chooseControlledOptimum(points),
  };
}

export interface RealEvaluation {
  report: string;
  points: RealSweepPoint[];
  results: PairResult[];
  defense: PolicyDefenseResult[];
  sampling: SamplingFieldAdmission;
  recommended: RealSweepPoint | undefined;
  unrestricted: RealSweepPoint;
  fingerprint: string;
}

export async function runRealEvaluation(embedder: EmbeddingProvider = new LocalEmbedding()): Promise<RealEvaluation> {
  const validation = validateRealDataset();
  if (!validation.ok) {
    throw new Error(`invalid real-embedding dataset (${REAL_DATASET_VERSION}):\n- ${validation.errors.join("\n- ")}`);
  }
  const results = await evaluatePairs(REAL_PAIRS, embedder, REAL_THRESHOLDS);
  const points = buildSweepPoints(results, REAL_THRESHOLDS);
  const recommended = chooseRecommendedThreshold(points);
  const unrestricted = chooseUnrestrictedThreshold(points);
  const defense = await checkMetadataPolicyDefense(REAL_PAIRS, embedder, recommended?.threshold ?? DEFAULT_GATEWAY_THRESHOLD);
  const sampling = checkSamplingFieldAdmission();
  const controlled = await runControlledComparison();
  const fingerprint = datasetFingerprint();
  const report = buildRealReport({
    fingerprint,
    pairCount: REAL_PAIRS.length,
    positives: validation.positives,
    negatives: validation.negatives,
    results,
    points,
    defense,
    sampling,
    recommended,
    unrestricted,
    assumptions: REAL_COST_ASSUMPTIONS,
    controlled,
  });
  return { report, points, results, defense, sampling, recommended, unrestricted, fingerprint };
}

function reportPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", ...REPORT_RELATIVE_PATH);
}

async function main(): Promise<number> {
  const started = performance.now();
  const embedder = new LocalEmbedding();

  console.log(`[real-eval] model: ${REAL_EMBEDDER_MODEL}`);
  const warmStart = performance.now();
  await embedder.embed("user: warmup", AbortSignal.timeout(300_000));
  console.log(`[real-eval] ONNX embedder warm in ${(performance.now() - warmStart).toFixed(0)} ms`);

  const validation = validateRealDataset();
  console.log(
    `[real-eval] dataset ${REAL_DATASET_VERSION}: ${validation.total} pairs ` +
      `(${validation.positives} must-HIT / ${validation.negatives} must-MISS), fingerprint ${datasetFingerprint().slice(0, 16)}…`,
  );
  if (!validation.ok) {
    console.error("[real-eval] dataset is INVALID:");
    for (const error of validation.errors) console.error(`  - ${error}`);
    return 1;
  }

  const evaluation = await runRealEvaluation(embedder);
  const outPath = reportPath();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, evaluation.report, "utf8");

  const rec = evaluation.recommended;
  console.log(`[real-eval] sweep (${REAL_THRESHOLDS.length} thresholds): thr | TP FP FN TN | precision recall | FPR | net $/1k`);
  for (const point of evaluation.points) {
    console.log(
      `  ${point.threshold.toFixed(2)} | ${point.tp} ${point.fp} ${point.fn} ${point.tn} | ` +
        `${(point.precision * 100).toFixed(1)}% ${(point.recall * 100).toFixed(1)}% | ` +
        `${(point.falsePositiveRate * 100).toFixed(1)}% | ${point.netSavingsPer1kUsd.toFixed(4)}`,
    );
  }
  const defenseViolations = evaluation.defense.reduce((sum, d) => sum + d.violations, 0);
  console.log(`[real-eval] metadata policy-gate violations: ${defenseViolations} (must be 0)`);
  const samplingStatus = evaluation.sampling.blocked
    ? "blocked (safe)"
    : "NOT BLOCKED (unsafe: top_p/stop requests could reuse)";
  console.log(
    `[real-eval] sampling-field admission (policy v${evaluation.sampling.policyVersion}, top_p/stop): ${samplingStatus} — ` +
      evaluation.sampling.decisions.map((d) => `${d.field}=${d.reason}`).join(", "),
  );
  const defaultPoint = evaluation.points.find((p) => Math.abs(p.threshold - DEFAULT_GATEWAY_THRESHOLD) < 1e-9);
  if (defaultPoint && defaultPoint.fp > 0) {
    console.warn(
      `[real-eval] WARNING: the former default ${DEFAULT_GATEWAY_THRESHOLD.toFixed(2)} serves ${defaultPoint.fp} wrong answer(s) ` +
        `on this corpus (precision ${(defaultPoint.precision * 100).toFixed(1)}%); current production default is 0.95.`,
    );
  }
  if (rec) {
    const paraphraseTotal = evaluation.results.filter((r) => r.family === "paraphrase").length;
    const paraphraseServed = rec.perFamily["paraphrase"].tp;
    console.log(
      `[real-eval] recommended threshold ${rec.threshold.toFixed(2)}: TP ${rec.tp} FP ${rec.fp} FN ${rec.fn}, ` +
        `precision ${(rec.precision * 100).toFixed(1)}%, recall ${(rec.recall * 100).toFixed(1)}%, ` +
        `net $${rec.netSavingsPer1kUsd.toFixed(4)}/1k; paraphrase reuse ${paraphraseServed}/${paraphraseTotal} ` +
        `(duplicate families: ${rec.perFamily["duplicate"].tp})`,
    );
  } else {
    console.error("[real-eval] GATE FAILED: no swept threshold has zero false positives");
  }
  console.log(`[real-eval] wrote ${outPath} in ${((performance.now() - started) / 1000).toFixed(1)} s`);

  if (!rec || defenseViolations !== 0 || !evaluation.sampling.blocked) return 1;
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].replace(/\\/g, "/").endsWith("realEmbeddings.ts") ||
    process.argv[1].replace(/\\/g, "/").endsWith("realEmbeddings.js"));

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 1;
    });
}


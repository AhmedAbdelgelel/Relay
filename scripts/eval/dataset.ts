// scripts/eval/dataset.ts — versioned labeled set for the semantic-threshold
// sweep (T15). The eval gate (agent/review.md §5) requires the mandatory
// families: duplicates, paraphrases, near-miss distractors, cross-domain,
// system-change, tenant-change — plus topical and unrelated negatives for
// fullness. Every fixture carries a family and a mustHit label, and
// validateDataset() enforces the minimum counts; both the harness script
// (`npm run eval`) and the tests call it, so the contract cannot drift.

export const DATASET_VERSION = "threshold-sweep/v1";

export type FixtureFamily =
  | "duplicate"
  | "paraphrase"
  | "near-miss"
  | "topical"
  | "cross-domain"
  | "system-change"
  | "tenant-change"
  | "unrelated";

export interface Fixture {
  name: string;
  family: FixtureFamily;
  /** Cosine similarity to the seeded reference answer the embedder reproduces exactly. */
  sim: number;
  /** The labeled truth: may this request legitimately reuse the seeded answer? */
  mustHit: boolean;
  /** System messages for this fixture (system-change family); default none. */
  system?: string[];
  /** Requesting tenant; default "default". */
  tenant?: string;
}

export const FAMILIES: readonly FixtureFamily[] = [
  "duplicate",
  "paraphrase",
  "near-miss",
  "topical",
  "cross-domain",
  "system-change",
  "tenant-change",
  "unrelated",
] as const;

/** Minimum fixture count per family, enforced by validateDataset(). */
export const MIN_PER_FAMILY = 3;

// Labeled set: positives clear the 0.92 bar with margin; the hardest
// must-MISS sits at 0.91 so the 0.90/0.92 boundary is directly probed.
// system-change / tenant-change carry HIGH similarity but must MISS via the
// policy gates (defense in depth over retrieval).
export const FIXTURES: readonly Fixture[] = [
  { name: "dup-1", family: "duplicate", sim: 1.0, mustHit: true },
  { name: "dup-2", family: "duplicate", sim: 1.0, mustHit: true },
  { name: "dup-3", family: "duplicate", sim: 1.0, mustHit: true },
  { name: "para-1", family: "paraphrase", sim: 0.99, mustHit: true },
  { name: "para-2", family: "paraphrase", sim: 0.97, mustHit: true },
  { name: "para-3", family: "paraphrase", sim: 0.95, mustHit: true },
  { name: "para-4", family: "paraphrase", sim: 0.94, mustHit: true },
  { name: "near-1", family: "near-miss", sim: 0.91, mustHit: false },
  { name: "near-2", family: "near-miss", sim: 0.89, mustHit: false },
  { name: "near-3", family: "near-miss", sim: 0.87, mustHit: false },
  { name: "near-4", family: "near-miss", sim: 0.85, mustHit: false },
  { name: "top-1", family: "topical", sim: 0.8, mustHit: false },
  { name: "top-2", family: "topical", sim: 0.75, mustHit: false },
  { name: "top-3", family: "topical", sim: 0.7, mustHit: false },
  { name: "cross-1", family: "cross-domain", sim: 0.5, mustHit: false },
  { name: "cross-2", family: "cross-domain", sim: 0.4, mustHit: false },
  { name: "cross-3", family: "cross-domain", sim: 0.3, mustHit: false },
  { name: "sys-1", family: "system-change", sim: 0.97, mustHit: false, system: ["other-instructions"] },
  { name: "sys-2", family: "system-change", sim: 0.96, mustHit: false, system: ["other-instructions"] },
  { name: "sys-3", family: "system-change", sim: 0.95, mustHit: false, system: ["other-instructions"] },
  { name: "ten-1", family: "tenant-change", sim: 0.97, mustHit: false, tenant: "other" },
  { name: "ten-2", family: "tenant-change", sim: 0.96, mustHit: false, tenant: "other" },
  { name: "ten-3", family: "tenant-change", sim: 0.95, mustHit: false, tenant: "other" },
  { name: "neg-1", family: "unrelated", sim: 0.1, mustHit: false },
  { name: "neg-2", family: "unrelated", sim: 0.05, mustHit: false },
  { name: "neg-3", family: "unrelated", sim: 0.0, mustHit: false },
];

export interface DatasetValidation {
  ok: boolean;
  errors: string[];
  counts: Record<FixtureFamily, number>;
}

/**
 * The dataset contract: every fixture labeled (mustHit) with a known family,
 * unique names, sims in [0,1], duplicate/paraphrase families must-HIT, every
 * other family must-MISS, and at least MIN_PER_FAMILY fixtures per family.
 */
export function validateDataset(fixtures: readonly Fixture[] = FIXTURES): DatasetValidation {
  const counts = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<FixtureFamily, number>;
  const errors: string[] = [];
  const names = new Set<string>();
  for (const f of fixtures) {
    if (!f.name) errors.push(`fixture with empty name (family ${f.family})`);
    else if (names.has(f.name)) errors.push(`duplicate fixture name: ${f.name}`);
    names.add(f.name);
    if (!FAMILIES.includes(f.family)) {
      errors.push(`${f.name}: unknown family ${f.family}`);
      continue;
    }
    counts[f.family]++;
    if (typeof f.mustHit !== "boolean") errors.push(`${f.name}: every fixture needs a mustHit label`);
    if (typeof f.sim !== "number" || !Number.isFinite(f.sim) || f.sim < 0 || f.sim > 1) {
      errors.push(`${f.name}: sim must be a finite number in [0,1]`);
    }
    if ((f.family === "duplicate" || f.family === "paraphrase") && !f.mustHit) {
      errors.push(`${f.name}: ${f.family} fixtures are must-HIT`);
    }
    if (f.family !== "duplicate" && f.family !== "paraphrase" && f.mustHit) {
      errors.push(`${f.name}: ${f.family} fixtures are must-MISS`);
    }
  }
  for (const family of FAMILIES) {
    if (counts[family] < MIN_PER_FAMILY) errors.push(`family ${family}: ${counts[family]} fixtures < minimum ${MIN_PER_FAMILY}`);
  }
  return { ok: errors.length === 0, errors, counts };
}

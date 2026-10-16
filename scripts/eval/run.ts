// scripts/eval/run.ts — `npm run eval`: run the deterministic T15 sweep and
// (re)write evaluation/report.md. Exits non-zero when the dataset fails its
// validation, so CI or a reviewer can gate on it. No randomness, no network,
// no provider spend.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { DATASET_VERSION, FIXTURES, validateDataset } from "./dataset.js";
import { buildReport, chooseOptimum, netUsd, seedStore, sweep, THRESHOLDS } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, "..", "..", "evaluation", "report.md");

const validation = validateDataset();
if (!validation.ok) {
  console.error(`[eval] dataset ${DATASET_VERSION} is invalid:`);
  for (const e of validation.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const store = new InMemoryVectorStore();
await seedStore(store);
const points = await sweep(store, THRESHOLDS);
const optimum = chooseOptimum(points);

const report = buildReport(points);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, report, "utf8");

const counts = Object.entries(validation.counts)
  .map(([family, n]) => `${family}=${n}`)
  .join(", ");
console.log(`[eval] dataset ${DATASET_VERSION}: ${FIXTURES.length} fixtures (${counts})`);
console.log("[eval] thr | TP FP FN TN | precision recall | net $");
for (const p of points) {
  console.log(
    `  ${p.threshold.toFixed(2)} | ${p.tp}  ${p.fp}  ${p.fn}  ${p.tn} | ${p.precision.toFixed(3)}   ${p.recall.toFixed(3)} | ${netUsd(p).toFixed(4)}`,
  );
}
console.log(`[eval] cost-aware optimum: ${optimum.threshold.toFixed(2)} -> wrote ${reportPath}`);

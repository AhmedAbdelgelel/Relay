// scripts/eval/realDataset.ts — versioned, deterministic labeled corpus for the
// REAL-embedding semantic-cache evaluation (Tasks 7–8). This file is data +
// labelling rules + validation only; the runner is scripts/eval/realEmbeddings.ts.
//
// WHY A SEPARATE DATASET
// ----------------------
// `scripts/eval/dataset.ts` is the controlled-cosine sweep: its "similarity" is
// prescribed by the fixture (`cos:0.91`), so it validates the threshold math and
// the policy gates, but it cannot say whether a real sentence-transformer
// actually separates safe paraphrases from dangerous near-misses. This corpus
// is labelled at the *question* level and scored with the real local ONNX
// embedder, so every cosine is the model's own output.
//
// LABELLING RULES (the `mustHit` label)
// -------------------------------------
// A pair is (cached prompt, incoming query prompt). `mustHit = true` iff
// reusing the cached answer for the incoming query is semantically safe:
//   * duplicate    — same question, only formatting/casing noise differs.
//   * paraphrase   — same information need, different wording; the cached answer
//                    answers the query unchanged.
// Every other family is `mustHit = false` because the answer differs in a way
// the policy gates or the embedding threshold must catch:
//   * near-miss    — same topic, different answer-critical entity/fact
//                    (e.g. capital of France vs Spain, top-5 vs top-10 risks).
//   * date-number  — dates, quantities, versions, prices, sizes change.
//   * constraint    — an added/removed constraint changes the answer (language,
//                    format, audience, negation, budget, audience, etc.).
//   * system-change — identical user text but a different system instruction
//                    (policy: system-fingerprint mismatch must block reuse).
//   * tenant-change — same text/scope but a different tenant (isolation).
//   * model-change  — same text but a different model id.
//   * generation-change — same text but different temperature / max_tokens.
//   * unrelated    — different topic entirely.
//
// SYNTHETIC-TEMPLATE LIMITATIONS (documented again in the report)
// ---------------------------------------------------------------
// * These are hand-authored prompt pairs, not observed production traffic; the
//   domain mix and the positive/negative ratio are assumptions, not a measured
//   traffic distribution. Re-validate on sampled real traffic before changing a
//   default.
// * English-only, short prompts, one embedding model version
//   (Xenova/all-mpnet-base-v2 q8). Different prompts/models/quantisation can
//   shift the cosine boundary.
// * "Safe" is judged at the question/answer level, not by an LLM judge; subtle
//   pragmatics (e.g. "cheapest" vs plain) are deliberately treated as
//   answer-changing negatives, which is the conservative labelling choice.
// * Pairs are evaluated one candidate row at a time (see realEmbeddings.ts), so
//   cross-row retrieval effects are out of scope; the HTTP e2e semantic tests
//   and `npm run bench` cover the serving path.
//
// Determinism: everything below is static data or generated from it with no
// clock, no randomness and no I/O. `datasetFingerprint()` pins the exact set.

import { createHash } from "node:crypto";

export const REAL_DATASET_VERSION = "real-embeddings/v1";

/** Single-provider corpus: production-route provider name used in every scope. */
export const PROVIDER_NAME = "mock";

/** Production request scope fields that participate in the reuse decision. */
export interface PromptScope {
  tenant: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  /** System instruction, when the request carries one. */
  system?: string;
}

export const DEFAULT_SCOPE = {
  tenant: "tenant-a",
  model: "relay-small",
  temperature: 1.0,
} as const satisfies PromptScope;

export type RealFamily =
  | "duplicate"
  | "paraphrase"
  | "near-miss"
  | "date-number"
  | "constraint"
  | "system-change"
  | "tenant-change"
  | "model-change"
  | "generation-change"
  | "unrelated";

export const REAL_FAMILIES: readonly RealFamily[] = [
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
] as const;

/** Families whose difference lives in request metadata: policy must block them. */
export const METADATA_FAMILIES: readonly RealFamily[] = [
  "system-change",
  "tenant-change",
  "model-change",
  "generation-change",
] as const;

export interface LabeledPair {
  /** Stable, unique, human-readable id (sortable by family when inspected). */
  id: string;
  family: RealFamily;
  /** The prompt of the row already in the semantic cache (answer: cached). */
  cachedPrompt: string;
  /** The incoming request's user prompt. */
  queryPrompt: string;
  cachedScope: PromptScope;
  queryScope: PromptScope;
  /** Ground truth: may the incoming query reuse the cached answer? */
  mustHit: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Base questions: each has two hand-written genuine paraphrases and two
// topically-similar-but-different-answer near-misses. 15 bases => 30 paraphrase
// pairs, 30 near-miss pairs and (3 variants each) 45 duplicate pairs.
// ---------------------------------------------------------------------------

interface BaseQuestion {
  id: string;
  question: string;
  paraphrases: [string, string];
  nearMisses: [string, string];
}

const BASES: readonly BaseQuestion[] = [
  {
    id: "france-capital",
    question: "What is the capital of France?",
    paraphrases: ["Which city is the capital of France?", "Name the capital city of France."],
    nearMisses: ["What is the capital of Spain?", "What is the population of Paris?"],
  },
  {
    id: "japan-currency",
    question: "What is the currency of Japan?",
    paraphrases: ["Which currency is used in Japan?", "What money is accepted in Japan?"],
    nearMisses: ["What is the currency of South Korea?", "What is the capital of Japan?"],
  },
  {
    id: "python-sort",
    question: "Write a Python function that sorts a list of integers.",
    paraphrases: [
      "Give me Python code to sort a list of integers.",
      "How do I sort a list of integers in Python?",
    ],
    nearMisses: [
      "Write a Python function that reverses a list of integers.",
      "Write a Python function that merges two lists of integers.",
    ],
  },
  {
    id: "sourdough",
    question: "How do I bake sourdough bread?",
    paraphrases: ["What is the process for making sourdough bread?", "Give me instructions to bake sourdough bread at home."],
    nearMisses: ["How do I bake rye bread?", "How do I store sourdough bread?"],
  },
  {
    id: "refund-policy",
    question: "What is the refund policy for annual subscriptions?",
    paraphrases: ["How does the refund policy work for yearly subscriptions?", "Can I get a refund on an annual subscription?"],
    nearMisses: ["What is the refund policy for monthly subscriptions?", "How do I cancel an annual subscription?"],
  },
  {
    id: "password-reset",
    question: "How do I reset my account password?",
    paraphrases: ["What steps do I follow to reset my password?", "I forgot my password - how can I reset it?"],
    nearMisses: ["How do I change my account password?", "How do I reset my two-factor authentication device?"],
  },
  {
    id: "q1-earnings",
    question: "Summarize the Q1 2025 earnings report.",
    paraphrases: ["Give me a summary of the Q1 2025 earnings report.", "What does the Q1 2025 earnings report say?"],
    nearMisses: ["Summarize the Q2 2025 earnings report.", "Summarize the Q1 2024 earnings report."],
  },
  {
    id: "kickoff-date",
    question: "Schedule the project kickoff meeting for March 3, 2025.",
    paraphrases: ["Set up the project kickoff meeting on March 3, 2025.", "Book the project kickoff meeting for 3 March 2025."],
    nearMisses: ["Schedule the project kickoff meeting for March 10, 2025.", "Schedule the project kickoff meeting for April 3, 2025."],
  },
  {
    id: "berlin-lisbon-flights",
    question: "Find flights from Berlin to Lisbon for two adults.",
    paraphrases: ["Search for flights from Berlin to Lisbon for 2 adults.", "I need flights from Berlin to Lisbon for two people."],
    nearMisses: ["Find flights from Berlin to Lisbon for three adults.", "Find flights from Berlin to Porto for two adults."],
  },
  {
    id: "paris-weather",
    question: "What is the weather forecast for Paris tomorrow?",
    paraphrases: ["How is the weather in Paris expected tomorrow?", "Tell me tomorrow's weather forecast for Paris."],
    nearMisses: ["What is the weather forecast for Paris next week?", "What is the weather forecast for London tomorrow?"],
  },
  {
    id: "rome-collapse",
    question: "Why did the Western Roman Empire collapse in the fifth century?",
    paraphrases: ["What caused the collapse of the Western Roman Empire in the 400s?", "Explain the fall of the Western Roman Empire in the fifth century."],
    nearMisses: ["Why did the Byzantine Empire collapse?", "When did the Western Roman Empire collapse?"],
  },
  {
    id: "security-risks",
    question: "List the top five security risks in a web application.",
    paraphrases: ["What are the five biggest security risks for a web app?", "Name the top 5 web application security risks."],
    nearMisses: ["List the top ten security risks in a web application.", "List the top five security risks in a mobile application."],
  },
  {
    id: "vegan-paris",
    question: "List vegan restaurants in Paris.",
    paraphrases: ["Find vegan restaurants in Paris.", "Which vegan restaurants are there in Paris?"],
    nearMisses: ["List vegan restaurants in Lyon.", "List vegetarian restaurants in Paris."],
  },
  {
    id: "free-plan-rate-limit",
    question: "What is the API rate limit for the free plan?",
    paraphrases: ["How many API requests does the free plan allow?", "What API rate limit applies to free-tier accounts?"],
    nearMisses: ["What is the API rate limit for the pro plan?", "What is the API request timeout for the free plan?"],
  },
  {
    id: "welcome-email",
    question: "Write a welcome email for new subscribers.",
    paraphrases: ["Draft a welcome email to send to new subscribers.", "Compose an email welcoming new subscribers."],
    nearMisses: ["Write a re-engagement email for inactive subscribers.", "Write a welcome SMS for new subscribers."],
  },
];

// ---------------------------------------------------------------------------
// Secondary hand-written material for the numeric/constraint/negative families.
// ---------------------------------------------------------------------------

/** [cachedPrompt, queryPrompt] — same template, answer-critical token changed. */
const DATE_NUMBER_PAIRS: readonly [string, string][] = [
  ["Compare the 2022 and 2023 revenue figures.", "Compare the 2023 and 2024 revenue figures."],
  ["Convert 15 miles to kilometres.", "Convert 25 miles to kilometres."],
  ["Schedule the launch for March 3, 2025.", "Schedule the launch for March 10, 2025."],
  ["Schedule the launch for March 3, 2025.", "Schedule the launch for April 3, 2025."],
  ["Find flights from Berlin to Lisbon departing at 08:00.", "Find flights from Berlin to Lisbon departing at 18:00."],
  ["Find flights from Berlin to Lisbon for two adults.", "Find flights from Berlin to Lisbon for two children."],
  ["Rank the top five security risks in a web application.", "Rank the top eight security risks in a web application."],
  ["List the top five security risks in a web application.", "List the top three security risks in a web application."],
  ["How many vacation days do full-time employees get?", "How many vacation days do part-time employees get?"],
  ["What is the maximum upload size for the free plan?", "What is the maximum upload size for the pro plan?"],
  ["Set the connection timeout to 30 seconds.", "Set the connection timeout to 60 seconds."],
  ["Set the retry count to 3.", "Set the retry count to 5."],
  ["Generate a report for the last 7 days.", "Generate a report for the last 30 days."],
  ["Generate a report for the last 7 days.", "Generate a report for the last 7 weeks."],
  ["Write a summary in 100 words.", "Write a summary in 500 words."],
  ["What changed in version 2.4.0?", "What changed in version 2.5.0?"],
  ["What changed in version 2.4.0?", "What changed in version 1.4.0?"],
  ["Book a table for 4 people at 7 pm.", "Book a table for 4 people at 8 pm."],
  ["Book a table for 4 people at 7 pm.", "Book a table for 6 people at 7 pm."],
  ["Renew the certificate before December 31, 2025.", "Renew the certificate before June 30, 2025."],
  ["The invoice total was $1,250.", "The invoice total was $1,520."],
  ["The invoice total was $1,250.", "The invoice total was EUR 1,250."],
  ["Summarize the 2023 audit findings.", "Summarize the 2024 audit findings."],
  ["Cap the response at 2,000 tokens.", "Cap the response at 4,000 tokens."],
];

/** [cachedPrompt, queryPrompt] — an added/removed constraint changes the answer. */
const CONSTRAINT_PAIRS: readonly [string, string][] = [
  ["List vegan restaurants in Paris.", "List vegan restaurants in Paris that are open after 10 pm."],
  ["List vegan restaurants in Paris.", "List vegan restaurants in Paris that deliver."],
  ["Write a Python function that sorts a list of integers.", "Write a Python function that sorts a list of integers without using built-in sort."],
  ["Write a Python function that sorts a list of integers.", "Write a Python function that sorts a list of integers recursively."],
  ["Write a Python function that sorts a list of integers.", "Write a JavaScript function that sorts a list of integers."],
  ["Write a SQL query to find duplicate emails.", "Write a SQL query to find duplicate emails and delete them."],
  ["Summarize the article in English.", "Summarize the article in French."],
  ["Summarize the article in English.", "Summarize the article in English in bullet points."],
  ["Generate a JSON schema for a user profile.", "Generate a YAML schema for a user profile."],
  ["Write a welcome email for new subscribers.", "Write a welcome email for new subscribers, under 100 words."],
  ["How do I reset my account password?", "How do I reset my account password without email access?"],
  ["Find flights from Berlin to Lisbon.", "Find direct flights from Berlin to Lisbon."],
  ["Find flights from Berlin to Lisbon.", "Find the cheapest flights from Berlin to Lisbon."],
  ["List the top five security risks in a web application.", "List the top five security risks in a web application, excluding authentication."],
  ["How do I bake sourdough bread?", "How do I bake gluten-free sourdough bread?"],
  ["How do I bake sourdough bread?", "How do I bake sourdough bread in a bread machine?"],
  ["What is the refund policy for annual subscriptions?", "What is the refund policy for annual subscriptions in the EU?"],
  ["Write an email asking for a deadline extension.", "Write a formal email asking for a deadline extension."],
  ["Create a marketing plan for a coffee shop.", "Create a marketing plan for a coffee shop with a $500 budget."],
  ["Write a cover letter for a software engineer position.", "Write a cover letter for a senior software engineer position."],
  ["Explain how photosynthesis works.", "Explain how photosynthesis works to a five-year-old."],
  ["Explain how photosynthesis works.", "Explain how photosynthesis works in one sentence."],
  ["Translate 'Good morning' into German.", "Translate 'Good morning' into Dutch."],
  ["Write a Python script that reads a CSV file.", "Write a Python script that reads a CSV file without pandas."],
];

/** Different-domain queries paired with base questions for the unrelated family. */
const UNRELATED_QUERIES: readonly string[] = [
  "Who won the 2018 FIFA World Cup?",
  "How do I fix a leaking kitchen faucet?",
  "What is the boiling point of water at sea level?",
  "Recommend a science fiction novel for a long flight.",
  "How do I prepare for a marathon in six months?",
  "What are the symptoms of seasonal allergies?",
  "How do solar panels convert sunlight into electricity?",
  "Which programming language is used for machine learning?",
  "What is the best way to learn to play the piano?",
  "How do I change a car tyre safely?",
  "What causes thunderstorms in summer?",
  "How do I make a classic tomato sauce?",
  "What is the history of the Internet?",
  "How do I improve my sleep quality?",
  "Which hiking trails are best in the Swiss Alps?",
];

/** System instructions cycled across the system-change family. */
const SYSTEM_VARIANTS: readonly string[] = [
  "You must answer in formal French only, with no English words.",
  "Answer as a terse technical support agent and never add small talk.",
  "You are a creative writing coach; answer in the style of a poem.",
  "Only cite primary sources and include a warning about uncertainty.",
  "Answer for a five-year-old audience using simple words.",
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const CACHED_SCOPE: PromptScope = {
  tenant: DEFAULT_SCOPE.tenant,
  model: DEFAULT_SCOPE.model,
  temperature: DEFAULT_SCOPE.temperature,
};

function baseScope(over: Partial<PromptScope> = {}): PromptScope {
  return { tenant: CACHED_SCOPE.tenant, model: CACHED_SCOPE.model, temperature: CACHED_SCOPE.temperature, ...over };
}

function pair(
  id: string,
  family: RealFamily,
  cachedPrompt: string,
  queryPrompt: string,
  mustHit: boolean,
  opts: { cachedScope?: PromptScope; queryScope?: PromptScope; note?: string } = {},
): LabeledPair {
  return {
    id,
    family,
    cachedPrompt,
    queryPrompt,
    cachedScope: opts.cachedScope ?? { ...CACHED_SCOPE },
    queryScope: opts.queryScope ?? { ...CACHED_SCOPE },
    mustHit,
    note: opts.note,
  };
}

/** Duplicate variants: identical question with formatting/casing noise only. */
function duplicateVariants(q: string): [string, string, string] {
  return [
    q, // exact replay
    q.replace(/ /g, "  ").trimEnd() + "  ", // internal + trailing whitespace noise
    q.toLowerCase(), // casing drift (same question)
  ];
}

export function buildRealDataset(): LabeledPair[] {
  const pairs: LabeledPair[] = [];

  for (const base of BASES) {
    const variants = duplicateVariants(base.question);
    pairs.push(pair(`dup-${base.id}-exact`, "duplicate", base.question, variants[0], true, {
      note: "byte-identical replay",
    }));
    pairs.push(pair(`dup-${base.id}-space`, "duplicate", base.question, variants[1], true, {
      note: "whitespace-only drift",
    }));
    pairs.push(pair(`dup-${base.id}-case`, "duplicate", base.question, variants[2], true, {
      note: "casing-only drift",
    }));
    base.paraphrases.forEach((paraphrase, i) => {
      pairs.push(pair(`par-${base.id}-${i + 1}`, "paraphrase", base.question, paraphrase, true));
    });
    base.nearMisses.forEach((nearMiss, i) => {
      pairs.push(pair(`near-${base.id}-${i + 1}`, "near-miss", base.question, nearMiss, false));
    });
  }

  DATE_NUMBER_PAIRS.forEach(([cachedPrompt, queryPrompt], i) => {
    pairs.push(pair(`date-${String(i + 1).padStart(2, "0")}`, "date-number", cachedPrompt, queryPrompt, false));
  });

  CONSTRAINT_PAIRS.forEach(([cachedPrompt, queryPrompt], i) => {
    pairs.push(pair(`cons-${String(i + 1).padStart(2, "0")}`, "constraint", cachedPrompt, queryPrompt, false));
  });

  BASES.forEach((base, i) => {
    const system = SYSTEM_VARIANTS[i % SYSTEM_VARIANTS.length] as string;
    pairs.push(
      pair(`sys-${base.id}`, "system-change", base.question, base.question, false, {
        queryScope: baseScope({ system }),
        note: "same user text, different system instruction",
      }),
    );
    pairs.push(
      pair(`tenant-${base.id}`, "tenant-change", base.question, base.question, false, {
        queryScope: baseScope({ tenant: "tenant-b" }),
        note: "same text and model on another tenant",
      }),
    );
    pairs.push(
      pair(`model-${base.id}`, "model-change", base.question, base.question, false, {
        queryScope: baseScope({ model: "relay-large" }),
        note: "same text on a different model id",
      }),
    );
    if (i < 10) {
      pairs.push(
        pair(`gen-temp-${base.id}`, "generation-change", base.question, base.question, false, {
          queryScope: baseScope({ temperature: 0.3 }),
          note: "temperature differs (1.0 cached vs 0.3 requested)",
        }),
      );
    }
    if (i >= 5) {
      pairs.push(
        pair(`gen-maxtok-${base.id}`, "generation-change", base.question, base.question, false, {
          queryScope: baseScope({ maxTokens: 512 }),
          note: "max_tokens differs (unset cached vs 512 requested)",
        }),
      );
    }
  });

  BASES.forEach((base, i) => {
    const unrelated = UNRELATED_QUERIES[i] as string;
    pairs.push(pair(`unrel-${String(i + 1).padStart(2, "0")}`, "unrelated", base.question, unrelated, false));
  });

  return pairs;
}

/** The frozen corpus used by the runner, the report and the unit test. */
export const REAL_PAIRS: readonly LabeledPair[] = buildRealDataset();

// ---------------------------------------------------------------------------
// Validation contract (the runner exits non-zero when this fails)
// ---------------------------------------------------------------------------

export const MIN_REAL_PER_FAMILY: Record<RealFamily, number> = {
  duplicate: 30,
  paraphrase: 24,
  "near-miss": 24,
  "date-number": 16,
  constraint: 16,
  "system-change": 10,
  "tenant-change": 10,
  "model-change": 10,
  "generation-change": 12,
  unrelated: 10,
};

export const MIN_TOTAL_PAIRS = 200;
export const MAX_TOTAL_PAIRS = 500;

export interface RealDatasetValidation {
  ok: boolean;
  errors: string[];
  counts: Record<RealFamily, number>;
  positives: number;
  negatives: number;
  total: number;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function scopeDiff(a: PromptScope, b: PromptScope): Set<string> {
  const fields = new Set<string>();
  if (a.tenant !== b.tenant) fields.add("tenant");
  if (a.model !== b.model) fields.add("model");
  if (a.temperature !== b.temperature) fields.add("temperature");
  if ((a.maxTokens ?? undefined) !== (b.maxTokens ?? undefined)) fields.add("maxTokens");
  if ((a.system ?? "") !== (b.system ?? "")) fields.add("system");
  return fields;
}

export function validateRealDataset(pairs: readonly LabeledPair[] = REAL_PAIRS): RealDatasetValidation {
  const counts = Object.fromEntries(REAL_FAMILIES.map((f) => [f, 0])) as Record<RealFamily, number>;
  const errors: string[] = [];
  const ids = new Set<string>();
  let positives = 0;
  let negatives = 0;

  for (const p of pairs) {
    if (!p.id) errors.push("pair with empty id");
    else if (ids.has(p.id)) errors.push(`duplicate pair id: ${p.id}`);
    ids.add(p.id);

    if (!REAL_FAMILIES.includes(p.family)) {
      errors.push(`${p.id}: unknown family ${String(p.family)}`);
      continue;
    }
    counts[p.family] += 1;

    if (typeof p.mustHit !== "boolean") errors.push(`${p.id}: mustHit must be boolean`);
    if (p.mustHit) positives += 1;
    else negatives += 1;

    if (!p.cachedPrompt.trim()) errors.push(`${p.id}: empty cachedPrompt`);
    if (!p.queryPrompt.trim()) errors.push(`${p.id}: empty queryPrompt`);
    for (const [label, scope] of [
      ["cachedScope", p.cachedScope],
      ["queryScope", p.queryScope],
    ] as const) {
      if (!scope.tenant) errors.push(`${p.id}: ${label}.tenant is empty`);
      if (!scope.model.trim()) errors.push(`${p.id}: ${label}.model is empty`);
      if (!(scope.temperature >= 0 && scope.temperature <= 2)) errors.push(`${p.id}: ${label}.temperature outside [0,2]`);
      if (scope.maxTokens !== undefined && !(Number.isInteger(scope.maxTokens) && scope.maxTokens > 0)) {
        errors.push(`${p.id}: ${label}.maxTokens must be a positive integer when set`);
      }
    }

    const textSame = p.cachedPrompt === p.queryPrompt;
    const diff = scopeDiff(p.cachedScope, p.queryScope);
    const sameScope = diff.size === 0;

    if (p.family === "duplicate" || p.family === "paraphrase") {
      if (!p.mustHit) errors.push(`${p.id}: ${p.family} pairs are must-HIT`);
      if (!sameScope) errors.push(`${p.id}: ${p.family} pairs must keep the same request scope`);
    } else {
      if (p.mustHit) errors.push(`${p.id}: ${p.family} pairs are must-MISS`);
    }

    if (p.family === "duplicate") {
      if (!textSame) {
        const a = normalizeText(p.cachedPrompt);
        const b = normalizeText(p.queryPrompt);
        if (a !== b) errors.push(`${p.id}: duplicate pair differs beyond whitespace/casing`);
      }
    }
    if (p.family === "paraphrase") {
      if (textSame) errors.push(`${p.id}: paraphrase pair must use different wording`);
      if (!sameScope) errors.push(`${p.id}: paraphrase pair must keep the same request scope`);
    }
    if (p.family === "near-miss" || p.family === "date-number" || p.family === "constraint") {
      if (textSame) errors.push(`${p.id}: ${p.family} pair must change the prompt text`);
      if (!sameScope) errors.push(`${p.id}: ${p.family} pair must keep the same request scope`);
    }
    if (p.family === "unrelated") {
      if (textSame) errors.push(`${p.id}: unrelated pair must change the prompt text`);
      if (!sameScope) errors.push(`${p.id}: unrelated pair must keep the same request scope`);
    }
    if (p.family === "system-change") {
      if (textSame && !diff.has("system")) errors.push(`${p.id}: system-change must differ in the system instruction`);
      if (diff.size !== 1 || !diff.has("system")) errors.push(`${p.id}: system-change must only differ in 'system' (got: ${[...diff].join(",") || "none"})`);
    }
    if (p.family === "tenant-change") {
      if (textSame && !diff.has("tenant")) errors.push(`${p.id}: tenant-change must differ in tenant`);
      if (diff.size !== 1 || !diff.has("tenant")) errors.push(`${p.id}: tenant-change must only differ in 'tenant' (got: ${[...diff].join(",") || "none"})`);
    }
    if (p.family === "model-change") {
      if (textSame && !diff.has("model")) errors.push(`${p.id}: model-change must differ in model`);
      if (diff.size !== 1 || !diff.has("model")) errors.push(`${p.id}: model-change must only differ in 'model' (got: ${[...diff].join(",") || "none"})`);
    }
    if (p.family === "generation-change") {
      const generationField = diff.has("temperature") || diff.has("maxTokens");
      if (!generationField) errors.push(`${p.id}: generation-change must differ in temperature or max_tokens`);
      for (const field of diff) {
        if (field !== "temperature" && field !== "maxTokens") {
          errors.push(`${p.id}: generation-change must not differ in '${field}'`);
        }
      }
    }
  }

  if (pairs.length < MIN_TOTAL_PAIRS) errors.push(`dataset has ${pairs.length} pairs < minimum ${MIN_TOTAL_PAIRS}`);
  if (pairs.length > MAX_TOTAL_PAIRS) errors.push(`dataset has ${pairs.length} pairs > maximum ${MAX_TOTAL_PAIRS}`);
  for (const family of REAL_FAMILIES) {
    if (counts[family] < MIN_REAL_PER_FAMILY[family]) {
      errors.push(`family ${family}: ${counts[family]} pairs < minimum ${MIN_REAL_PER_FAMILY[family]}`);
    }
  }
  if (positives < 40) errors.push(`dataset has ${positives} must-HIT pairs < minimum 40`);
  if (negatives < 100) errors.push(`dataset has ${negatives} must-MISS pairs < minimum 100`);

  return { ok: errors.length === 0, errors, counts, positives, negatives, total: pairs.length };
}

/** Stable content hash so the exact corpus is inspectable and version-pinned. */
export function datasetFingerprint(pairs: readonly LabeledPair[] = REAL_PAIRS): string {
  const canonical = pairs.map((p) => [
    p.id,
    p.family,
    p.cachedPrompt,
    p.queryPrompt,
    p.cachedScope.tenant,
    p.cachedScope.model,
    p.cachedScope.temperature,
    p.cachedScope.maxTokens ?? null,
    p.cachedScope.system ?? null,
    p.queryScope.tenant,
    p.queryScope.model,
    p.queryScope.temperature,
    p.queryScope.maxTokens ?? null,
    p.queryScope.system ?? null,
    p.mustHit,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

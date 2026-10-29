// scripts/bench/perf.ts — repeatable end-to-end performance benchmark.
//
// HOW TO RUN
//   npx tsx scripts/bench/perf.ts            # full run (~2-4 min on a shared box)
//   npx tsx scripts/bench/perf.ts --quick    # smoke config (see QUICK below)
//   BENCH_N=200 BENCH_REPEATS=2 BENCH_CONCURRENCY=1,10 npx tsx scripts/bench/perf.ts
//   BENCH_SCENARIOS=exact_hit,concurrent_identical npx tsx scripts/bench/perf.ts
//
// (The Lead wires this as `npm run bench:perf`; this file does not touch
// package.json. The correctness benchmark `scripts/bench/cache.ts` is kept
// untouched.)
//
// WHAT THIS MEASURES
//   The real gateway HTTP path — Fastify app with the real routes, lane guard,
//   exact cache, semantic cache, single-flight, fallback chain and provider
//   adapter — booted on a real 127.0.0.1 loopback socket and driven with
//   Node fetch (no app.inject, no vitest, no external network).
//
//   Wiring: MockProvider with a small fixed delay (2 ms; 10 ms for the
//   stampede bursts so coalescing is observable), InMemoryCache,
//   InMemoryVectorStore, MockEmbedding (deterministic, fast), one seeded
//   registered lane via GATEWAY_API_KEYS.
//
//   These are GATEWAY/CACHE measurements with a mock provider. They are NOT
//   real LLM latency, NOT real embedding-provider latency, and NOT real Redis
//   or pgvector latency.
//
// SCENARIOS
//   exact_hit              identical prompt after admission       -> x-cache HIT
//   exact_miss             1,000 unique prompts                   -> x-cache MISS
//   semantic_hit           seeded vector row + MockEmbedding      -> SEMANTIC_HIT
//   unique_no_cache        1,000 unique prompts, 500-entry LRU    -> MISS, evictions exercised
//   concurrent_identical   cold prompt fired at 50 / 100 at once  -> 1 provider call
//   mixed_70_30            700 pre-seeded hit prompts + 300 misses per 1,000 requests
//
//   Each scenario is run at concurrency 1/10/50/100 (stampede: burst size
//   50/100) with 5 repeats and a fixed warm-up. Per-run and per-(scenario,
//   concurrency) aggregate rows report P50/P95/P99 client RTT, throughput
//   req/s, error rate, instrumented provider calls vs expected, and
//   RSS/heap before/after.
//
// EXIT CODE
//   0 only when every hard expectation passes: every request 2xx, expected
//   x-cache verdict, expected provider-call count, no 5xx, error rate under
//   the threshold, and a post-measurement replay that is served without a
//   provider call (no stuck in-flight state). A machine-readable BENCH_JSON
//   line is printed last; latencies are reported as measured, never tuned.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { cpus, release, type, totalmem } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { registerConnectionsRoutes } from "../../src/api/routes/connections.js";
import { registerPlayground } from "../../src/api/routes/playground.js";
import { registerProviderRoutes } from "../../src/api/routes/providers.js";
import { registerRegisterRoutes } from "../../src/api/routes/register.js";
import { registerUsageRoutes } from "../../src/api/routes/usage.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { buildExactCacheKey } from "../../src/domain/normalize.js";
import type { ChatRequest } from "../../src/domain/types.js";
import { promptTextForEmbedding, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import { MockEmbedding } from "../../src/embeddings/MockEmbedding.js";
import { loadConfig, type GatewayConfig } from "../../src/infrastructure/config.js";
import type { MetricsSnapshot } from "../../src/observability/metrics.js";
import { metrics } from "../../src/observability/metrics.js";
import { POLICY_VERSION, systemFingerprint } from "../../src/policy/reuse.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";
import { createProviderFromEnv } from "../../src/providers/factory.js";

// ---------------------------------------------------------------------------
// Configuration (environment-overridable; defaults are the reported config)
// ---------------------------------------------------------------------------

const QUICK = process.argv.includes("--quick");
const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new Error(`${name} must be a positive integer; got "${raw}"`);
  return n;
};

const N_REQUESTS = QUICK ? 100 : envInt("BENCH_N", 1000);
const N_REPEATS = QUICK ? 1 : envInt("BENCH_REPEATS", 5);
const WARMUP = QUICK ? 3 : envInt("BENCH_WARMUP", 20);
const MAX_ERROR_RATE = 0.001;
const MOCK_DELAY_MS = 2;
const STAMPEDE_DELAY_MS = 10;
const STAMPEDE_SIZES = [50, 100] as const;

function parseLevels(): number[] {
  const raw = QUICK ? "1,10" : (process.env["BENCH_CONCURRENCY"] ?? "1,10,50,100");
  const levels = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
  if (levels.length === 0) throw new Error(`BENCH_CONCURRENCY must be comma-separated positive integers; got "${raw}"`);
  return levels;
}
const CONCURRENCY_LEVELS = parseLevels();

const TENANT = "perf";
// Deterministic dev-only key (the seeded store hashes it like a real lg_ key).
const KEY = "lg_perf_0123456789abcdef0123456789abcdefc3";
const RUN_MARKER = new Date().toISOString();
const NOTE = "mock provider (2 ms) — gateway/cache measurement, not real LLM latency";

const BASE_ENV: Record<string, string> = {
  PROVIDER: "mock",
  CACHE_ENABLED: "true",
  CACHE_TTL_S: "3600",
  REDIS_URL: "",
  SEMANTIC_ENABLED: "true",
  SEMANTIC_STORE: "memory",
  SEMANTIC_THRESHOLD: "0.92",
  SEMANTIC_TOP_K: "3",
  SEMANTIC_TTL_S: "3600",
  EMBEDDING_PROVIDER: "mock",
  GATEWAY_API_KEYS: `${TENANT}:mock:perf-lane:${KEY}`,
  DATABASE_URL: "",
  CRED_ENC_KEY: "",
  UPSTREAM_TIMEOUT_MS: "10000",
  SAVED_USD_PER_1K_TOKENS: "0",
  // Live credentials stay empty even if the shell defines them: this run must
  // never be able to reach a real provider.
  GEMINI_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPEN_ROUTER_KEY: "",
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const emit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface Check {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}
const checks: Check[] = [];

const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const bounded = (n: number, cap = 1e9): number => (Number.isFinite(n) ? Math.max(0, Math.min(cap, n)) : 0);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] as number;
}

interface LatencyStats {
  n: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
}

function latencyStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = sorted.length === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    avg_ms: round(avg),
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    min_ms: round(sorted[0] ?? 0),
    max_ms: round(sorted[sorted.length - 1] ?? 0),
  };
}

interface MemoryMb {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
}

function memoryMb(): MemoryMb {
  const m = process.memoryUsage();
  return {
    rss_mb: round(m.rss / (1024 * 1024), 1),
    heap_used_mb: round(m.heapUsed / (1024 * 1024), 1),
    heap_total_mb: round(m.heapTotal / (1024 * 1024), 1),
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function pkgVersion(name: string): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), "node_modules", name, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// App builder: the real composition root, in-process, on a real socket
// ---------------------------------------------------------------------------

interface BenchApp {
  app: FastifyInstance;
  cfg: GatewayConfig;
  provider: ProviderAdapter;
  cache: CacheRepository;
  semanticStore?: InMemoryVectorStore;
  embedder?: EmbeddingProvider;
  url: string;
  providerCalls: () => number;
}

interface StartAppOptions {
  semantic: boolean;
  mockDelayMs: number;
  cache?: CacheRepository;
}

/** Count real adapter invocations, independent of the /metrics counter. */
function instrumentProvider(provider: ProviderAdapter): () => number {
  let calls = 0;
  const original = provider.chat.bind(provider);
  provider.chat = async (req, signal) => {
    calls += 1;
    return original(req, signal);
  };
  return () => calls;
}

async function startApp(opts: StartAppOptions): Promise<BenchApp> {
  const env: Record<string, string> = { ...BASE_ENV, ...(opts.semantic ? {} : { SEMANTIC_ENABLED: "false" }) };
  const cfg = loadConfig(env as NodeJS.ProcessEnv);
  const app = Fastify({ logger: false });
  const provider = createProviderFromEnv(cfg, { delayMs: opts.mockDelayMs });
  const providerCalls = instrumentProvider(provider);
  const cache: CacheRepository = opts.cache ?? new InMemoryCache();
  const semanticStore = opts.semantic ? new InMemoryVectorStore() : undefined;
  const embedder = opts.semantic ? new MockEmbedding() : undefined;
  const providers = new Map<string, ProviderAdapter>([["mock", provider]]);
  const auth = {
    apiKeys: new InMemoryApiKeyStore(cfg.gatewayApiKeys),
    credentials: new InMemoryCredentialStore(new CredentialCipher(cfg.credEncKey || "perf-dev-secret")),
  };
  registerChatRoutes(app, provider, cfg, cache, { semanticStore, embedder, providers, auth });
  registerRegisterRoutes(app, cfg, auth);
  registerConnectionsRoutes(app, cfg, auth);
  registerUsageRoutes(app, auth);
  registerProviderRoutes(app, cfg, providers);
  registerPlayground(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  return {
    app,
    cfg,
    provider,
    cache,
    semanticStore,
    embedder,
    url: `http://127.0.0.1:${address.port}`,
    providerCalls,
  };
}

async function stopApp(target: BenchApp | undefined): Promise<void> {
  if (!target) return;
  try {
    target.app.server.closeIdleConnections();
    await target.app.close();
  } catch {
    /* already closed */
  }
}

// ---------------------------------------------------------------------------
// HTTP client (real loopback socket, undici keep-alive)
// ---------------------------------------------------------------------------

type Role = "system" | "user" | "assistant";

interface ChatBody {
  model: string;
  messages: { role: Role; content: string }[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface ChatResult {
  status: number;
  wallMs: number;
  cache: string;
  coalesced: string;
  provider: string;
  content: string;
}

interface ChatApiResponse {
  choices?: { message?: { content?: string } }[];
}

async function postChat(url: string, key: string, body: ChatBody): Promise<ChatResult> {
  const t0 = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const wallMs = performance.now() - t0;
  let parsed: ChatApiResponse | undefined;
  try {
    parsed = JSON.parse(text) as ChatApiResponse;
  } catch {
    parsed = undefined;
  }
  return {
    status: res.status,
    wallMs,
    cache: res.headers.get("x-cache") ?? "",
    coalesced: res.headers.get("x-coalesced") ?? "",
    provider: res.headers.get("x-provider") ?? "",
    content: parsed?.choices?.[0]?.message?.content ?? "",
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

function toChatRequest(body: ChatBody): ChatRequest {
  return {
    model: body.model,
    messages: body.messages,
    temperature: body.temperature ?? 1.0,
    max_tokens: body.max_tokens,
    stream: body.stream ?? false,
  };
}

const userBody = (model: string, content: string): ChatBody => ({ model, messages: [{ role: "user", content }] });

/**
 * Cache-key compatibility shim. A parallel workstream may add a required
 * tenant argument to buildExactCacheKey(providerName, req, tenant); passing it
 * is harmless on the current two-argument signature, so this benchmark compiles
 * and behaves identically against either baseline without touching src/.
 */
type CacheKeyBuilder = (providerName: string, req: ChatRequest, tenant?: string) => { key: string; hash: string };
const cacheKeyFor = (req: ChatRequest): { key: string; hash: string } =>
  (buildExactCacheKey as unknown as CacheKeyBuilder)("mock", req, TENANT);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioContext {
  level: number;
  repeat: number;
  n: number;
}

interface VerifyContext {
  level: number;
  n: number;
  providerCalls: number;
  metrics: MetricsSnapshot;
}

interface ScenarioPlan {
  measured: ChatBody[];
  warmup: ChatBody[];
  replay: ChatBody;
  expectedProviderCalls: number;
  verify: (samples: ChatResult[], ctx: VerifyContext) => string[];
}

interface Scenario {
  id: string;
  title: string;
  semantic: boolean;
  mockDelayMs: number;
  levels: number[];
  nForLevel: (level: number) => number;
  newCache?: () => CacheRepository;
  prepare: (app: BenchApp, ctx: ScenarioContext) => Promise<ScenarioPlan>;
}

const verdictCountsOf = (samples: ChatResult[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const s of samples) counts[s.cache] = (counts[s.cache] ?? 0) + 1;
  return counts;
};

const badVerdicts = (samples: ChatResult[], expected: string): ChatResult[] => samples.filter((s) => s.cache !== expected);

function commonVerdictProblem(samples: ChatResult[], expected: string): string[] {
  const bad = badVerdicts(samples, expected);
  if (bad.length === 0) return [];
  const first = bad[0]!;
  return [`${bad.length}/${samples.length} samples were not ${expected} (first: ${first.status} ${first.cache || "<none>"})`];
}

function semanticHitScenario(): Scenario {
  return {
    id: "semantic_hit",
    title: "semantic HIT (seeded vector row, MockEmbedding)",
    semantic: true,
    mockDelayMs: MOCK_DELAY_MS,
    levels: CONCURRENCY_LEVELS,
    nForLevel: () => N_REQUESTS,
    prepare: async (app, ctx) => {
      if (!app.embedder || !app.semanticStore) throw new Error("semantic_hit requires an embedder and a semantic store");
      const body = userBody("perf-sem", `perf semantic hit ${RUN_MARKER} r${ctx.repeat}: the answer is already in the vector store`);
      const req = toChatRequest(body);
      const promptText = promptTextForEmbedding(req);
      const embedding = await app.embedder.embed(promptText, new AbortController().signal);
      await app.semanticStore.save({
        tenant: TENANT,
        provider: "mock",
        model: body.model,
        promptHash: cacheKeyFor(req).hash,
        promptText,
        temperature: req.temperature,
        maxTokens: req.max_tokens,
        embedding,
        content: "seeded semantic answer",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        ttlSeconds: 3600,
        systemFingerprint: systemFingerprint(req),
        policyVersion: POLICY_VERSION,
      });
      const warmup = Array.from({ length: WARMUP }, () => body);
      return {
        measured: Array.from({ length: ctx.n }, () => body),
        warmup,
        replay: body,
        expectedProviderCalls: 0,
        verify: (samples, v) => {
          const problems = commonVerdictProblem(samples, "SEMANTIC_HIT");
          if (v.providerCalls !== 0) problems.push(`provider called ${v.providerCalls} times during semantic HIT window`);
          if (v.metrics.semantic_hits !== v.n) problems.push(`/metrics semantic_hits=${v.metrics.semantic_hits}, expected ${v.n}`);
          if (v.metrics.provider_requests !== 0) problems.push(`/metrics provider_requests=${v.metrics.provider_requests}, expected 0`);
          return problems;
        },
      };
    },
  };
}

function exactHitScenario(): Scenario {
  return {
    id: "exact_hit",
    title: "exact HIT (repeated identical prompt)",
    semantic: true,
    mockDelayMs: MOCK_DELAY_MS,
    levels: CONCURRENCY_LEVELS,
    nForLevel: () => N_REQUESTS,
    prepare: async (app, ctx) => {
      const body = userBody("perf-hit", `perf exact hit ${RUN_MARKER} r${ctx.repeat}: an identical repeated prompt`);
      const seed = await postChat(app.url, KEY, body);
      if (seed.status !== 200 || seed.cache !== "MISS") throw new Error(`exact_hit seed expected 200 MISS, got ${seed.status} ${seed.cache}`);
      const warmup = Array.from({ length: WARMUP }, () => body);
      return {
        measured: Array.from({ length: ctx.n }, () => body),
        warmup,
        replay: body,
        expectedProviderCalls: 0,
        verify: (samples, v) => {
          const problems = commonVerdictProblem(samples, "HIT");
          if (v.providerCalls !== 0) problems.push(`provider called ${v.providerCalls} times during HIT window`);
          if (v.metrics.exact_hits !== v.n) problems.push(`/metrics exact_hits=${v.metrics.exact_hits}, expected ${v.n}`);
          return problems;
        },
      };
    },
  };
}

function exactMissScenario(): Scenario {
  return {
    id: "exact_miss",
    title: "exact MISS (1,000 unique prompts, mock provider)",
    semantic: false, // semantic lookups would make each miss O(rows); measured separately
    mockDelayMs: MOCK_DELAY_MS,
    levels: CONCURRENCY_LEVELS,
    nForLevel: () => N_REQUESTS,
    prepare: async (_app, ctx) => {
      const measured = Array.from({ length: ctx.n }, (_, i) =>
        userBody("perf-miss", `perf exact miss ${RUN_MARKER} r${ctx.repeat} i${i}: a prompt nobody has asked before`),
      );
      const warmup = Array.from({ length: WARMUP }, (_, i) =>
        userBody("perf-miss", `perf miss warmup ${RUN_MARKER} r${ctx.repeat} w${i}: warm-up only`),
      );
      return {
        measured,
        warmup,
        // Replay the last measured body so it is guaranteed resident even if
        // the exact cache had to evict older entries while admitting 1,000
        // unique prompts.
        replay: measured[Math.max(0, ctx.n - 1)]!,
        expectedProviderCalls: ctx.n,
        verify: (samples, v) => {
          const problems = commonVerdictProblem(samples, "MISS");
          if (v.providerCalls !== v.n) problems.push(`provider calls=${v.providerCalls}, expected ${v.n} (one per unique MISS)`);
          if (v.metrics.exact_misses !== v.n) problems.push(`/metrics exact_misses=${v.metrics.exact_misses}, expected ${v.n}`);
          if (v.metrics.provider_requests !== v.n) problems.push(`/metrics provider_requests=${v.metrics.provider_requests}, expected ${v.n}`);
          return problems;
        },
      };
    },
  };
}

function uniqueNoCacheScenario(): Scenario {
  return {
    id: "unique_no_cache",
    title: "unique no-cache (1,000 unique prompts, 500-entry LRU)",
    semantic: false,
    mockDelayMs: MOCK_DELAY_MS,
    levels: CONCURRENCY_LEVELS,
    nForLevel: () => N_REQUESTS,
    newCache: () => new InMemoryCache({ maxEntries: 500 }),
    prepare: async (_app, ctx) => {
      const measured = Array.from({ length: ctx.n }, (_, i) =>
        userBody("perf-unique", `perf unique ${RUN_MARKER} r${ctx.repeat} i${i}: high-cardinality content that can never be reused`),
      );
      const warmup = Array.from({ length: WARMUP }, (_, i) => userBody("perf-unique", `perf unique warmup ${RUN_MARKER} r${ctx.repeat} w${i}`));
      return {
        measured,
        warmup,
        // With 1,000 unique inserts into a 500-entry LRU, only the most recent
        // ~500 entries are resident. Replay the final measured body: it is by
        // construction among the newest inserts, so it must be an exact HIT
        // (this checks admission/no-stuck-state without pretending the LRU is
        // unbounded).
        replay: measured[Math.max(0, ctx.n - 1)]!,
        expectedProviderCalls: ctx.n,
        verify: (samples, v) => {
          const problems = commonVerdictProblem(samples, "MISS");
          if (v.providerCalls !== v.n) problems.push(`provider calls=${v.providerCalls}, expected ${v.n} (unique prompts cannot be reused)`);
          if (v.metrics.exact_misses !== v.n) problems.push(`/metrics exact_misses=${v.metrics.exact_misses}, expected ${v.n}`);
          return problems;
        },
      };
    },
  };
}

function concurrentIdenticalScenario(): Scenario {
  return {
    id: "concurrent_identical",
    title: "concurrent identical (single-flight 50 / 100)",
    semantic: true, // a cold prompt + a few rows: the scan stays cheap and exercises the real path
    mockDelayMs: STAMPEDE_DELAY_MS,
    levels: [...STAMPEDE_SIZES],
    nForLevel: (level) => level,
    prepare: async (_app, ctx) => {
      const n = ctx.n;
      const cold = userBody("perf-stampede", `perf stampede cold ${RUN_MARKER} r${ctx.repeat} n${n}: ${"same prompt ".repeat(3)}`);
      const warm = userBody("perf-stampede", `perf stampede warmup ${RUN_MARKER} r${ctx.repeat}: separate warm-up prompt`);
      return {
        measured: Array.from({ length: n }, () => cold),
        // Warm-up fires one request per measured slot so the loopback keep-alive
        // pool has n established sockets before the burst is measured (a real
        // stampede happens on already-connected clients).
        warmup: Array.from({ length: n }, () => warm),
        replay: cold,
        expectedProviderCalls: 1,
        verify: (samples, v) => {
          const problems: string[] = [];
          const wrong = samples.filter((s) => s.status !== 200);
          if (wrong.length > 0) problems.push(`${wrong.length}/${samples.length} stampede requests were not 200`);
          const hits = samples.filter((s) => s.cache === "HIT").length;
          const coalesced = samples.filter((s) => s.coalesced === "true").length;
          const misses = samples.filter((s) => s.cache === "MISS").length;
          if (v.providerCalls !== 1) problems.push(`provider calls=${v.providerCalls}, expected exactly 1 for ${v.n} identical concurrent requests`);
          if (v.metrics.singleflight_leaders !== 1) problems.push(`/metrics singleflight_leaders=${v.metrics.singleflight_leaders}, expected 1`);
          if (coalesced + hits !== v.n - 1) {
            problems.push(`coalesced(${coalesced}) + exact hits(${hits}) = ${coalesced + hits}, expected ${v.n - 1} followers`);
          }
          if (misses + hits !== v.n) problems.push(`cache verdicts sum to ${misses + hits}, expected ${v.n}`);
          const uniqueAnswers = new Set(samples.map((s) => s.content)).size;
          if (uniqueAnswers !== 1) problems.push(`${uniqueAnswers} distinct answer bodies for one coalesced prompt`);
          if (v.metrics.provider_requests !== 1) problems.push(`/metrics provider_requests=${v.metrics.provider_requests}, expected 1`);
          return problems;
        },
      };
    },
  };
}

const MIXED_MODEL = "perf-mixed";
const MIXED_HIT_RATIO = 0.7;

function mixedPlan(hitCount: number, missCount: number, seed: number): ("hit" | "miss")[] {
  const plan: ("hit" | "miss")[] = [
    ...Array.from({ length: hitCount }, () => "hit" as const),
    ...Array.from({ length: missCount }, () => "miss" as const),
  ];
  const rnd = mulberry32(seed);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = plan[i]!;
    plan[i] = plan[j]!;
    plan[j] = tmp;
  }
  return plan;
}

function mixedScenario(): Scenario {
  return {
    id: "mixed_70_30",
    title: "mixed 70% HIT / 30% MISS per run",
    semantic: false,
    mockDelayMs: MOCK_DELAY_MS,
    levels: CONCURRENCY_LEVELS,
    nForLevel: () => N_REQUESTS,
    newCache: () => new InMemoryCache({ maxEntries: 5000 }),
    prepare: async (app, ctx) => {
      const n = ctx.n;
      const hitCount = Math.round(n * MIXED_HIT_RATIO);
      const missCount = n - hitCount;
      const measuredPlan = mixedPlan(hitCount, missCount, 0x51ed + ctx.repeat);
      const hitPrompts = Array.from({ length: hitCount }, (_, j) => `perf mixed hit ${RUN_MARKER} r${ctx.repeat} j${j}: seeded answer ${j}`);
      for (let j = 0; j < hitCount; j++) {
        const body = userBody(MIXED_MODEL, hitPrompts[j]!);
        const key = cacheKeyFor(toChatRequest(body)).key;
        await app.cache.set(
          key,
          JSON.stringify({ content: `seeded mixed answer ${j}`, model: MIXED_MODEL, usage: { prompt_tokens: 10, completion_tokens: 5 }, cachedAt: new Date().toISOString() }),
          3600,
        );
      }
      let hitIndex = 0;
      const measured: ChatBody[] = measuredPlan.map((kind, i) =>
        kind === "hit"
          ? userBody(MIXED_MODEL, hitPrompts[hitIndex++ % hitPrompts.length]!)
          : userBody(MIXED_MODEL, `perf mixed miss ${RUN_MARKER} r${ctx.repeat} i${i}: never seen before`),
      );
      const warmup = Array.from({ length: WARMUP }, (_, i) => userBody(MIXED_MODEL, hitPrompts[i % hitPrompts.length]!));
      return {
        measured: measured.slice(0, n),
        warmup,
        replay: measured[0]!,
        expectedProviderCalls: missCount,
        verify: (samples, v) => {
          const problems: string[] = [];
          const hits = samples.filter((s) => s.cache === "HIT").length;
          const misses = samples.filter((s) => s.cache === "MISS").length;
          if (hits + misses !== samples.length) problems.push(`${samples.length - hits - misses} samples had an unexpected x-cache verdict`);
          if (hits !== hitCount) problems.push(`HIT count=${hits}, expected ${hitCount}`);
          if (misses !== missCount) problems.push(`MISS count=${misses}, expected ${missCount}`);
          if (v.providerCalls !== missCount) problems.push(`provider calls=${v.providerCalls}, expected ${missCount}`);
          if (v.metrics.exact_hits !== hitCount) problems.push(`/metrics exact_hits=${v.metrics.exact_hits}, expected ${hitCount}`);
          if (v.metrics.provider_requests !== missCount) problems.push(`/metrics provider_requests=${v.metrics.provider_requests}, expected ${missCount}`);
          return problems;
        },
      };
    },
  };
}

function allScenarios(): Scenario[] {
  const scenarios = [
    exactHitScenario(),
    exactMissScenario(),
    semanticHitScenario(),
    uniqueNoCacheScenario(),
    concurrentIdenticalScenario(),
    mixedScenario(),
  ];
  const only = process.env["BENCH_SCENARIOS"];
  if (!only || only.trim() === "") return scenarios;
  const wanted = new Set(only.split(",").map((s) => s.trim()));
  const filtered = scenarios.filter((s) => wanted.has(s.id));
  if (filtered.length === 0) throw new Error(`BENCH_SCENARIOS matched none of: ${scenarios.map((s) => s.id).join(", ")}`);
  return filtered;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RunResult {
  scenario: string;
  level: number;
  repeat: number;
  n: number;
  setup_ms: number;
  warmup_ms: number;
  measured_ms: number;
  ok: number;
  errors: number;
  error_rate: number;
  verdict_counts: Record<string, number>;
  provider_calls: number;
  expected_provider_calls: number;
  latencies: number[];
  latency: LatencyStats;
  rps: number;
  memory: {
    rss_before_mb: number;
    rss_after_mb: number;
    heap_before_mb: number;
    heap_after_mb: number;
    rss_delta_mb: number;
    heap_delta_mb: number;
  };
  replay: { status: number; cache: string; extra_provider_calls: number };
  violations: string[];
}

async function measure(url: string, bodies: ChatBody[], concurrency: number): Promise<ChatResult[]> {
  const samples = new Array<ChatResult>(bodies.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= bodies.length) return;
      samples[i] = await postChat(url, KEY, bodies[i]!);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, bodies.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return samples;
}

async function runOnce(scenario: Scenario, level: number, repeat: number): Promise<RunResult> {
  const n = scenario.nForLevel(level);
  const setupStart = performance.now();
  const app = await startApp({ semantic: scenario.semantic, mockDelayMs: scenario.mockDelayMs, cache: scenario.newCache?.() });
  try {
    const plan = await scenario.prepare(app, { level, repeat, n });
    if (plan.measured.length !== n) throw new Error(`${scenario.id}: plan has ${plan.measured.length} measured bodies, expected ${n}`);
    const setupMs = performance.now() - setupStart;

    const warmupStart = performance.now();
    // Warm-up: enough requests to fill the keep-alive pool at the target
    // concurrency (so measured RTT is not dominated by socket creation) and to
    // JIT the serving path. Warm-up responses are never part of the statistics.
    const warmupBodies = Array.from({ length: Math.max(WARMUP, level) }, (_, i) => plan.warmup[i % plan.warmup.length]!);
    const warmupSamples = await measure(app.url, warmupBodies, level);
    const warmupMs = performance.now() - warmupStart;
    const warmupErrors = warmupSamples.filter((s) => s.status !== 200).length;

    const callsBefore = app.providerCalls();
    const memBefore = memoryMb();
    metrics.reset();
    const measuredStart = performance.now();
    const samples = await measure(app.url, plan.measured, level);
    const measuredMs = performance.now() - measuredStart;
    const providerCalls = app.providerCalls() - callsBefore;
    const metricsSnap = await getJson<MetricsSnapshot>(`${app.url}/metrics`);
    const memAfter = memoryMb();

    // Post-measurement replay: the answer must now be servable without a
    // provider call — evidence that no in-flight state was left stuck.
    const replay = await postChat(app.url, KEY, plan.replay);
    const extraProviderCalls = app.providerCalls() - callsBefore - providerCalls;

    const errors = samples.filter((s) => s.status < 200 || s.status >= 300).length;
    const violations: string[] = [];
    const non200 = samples.filter((s) => s.status !== 200);
    if (warmupErrors > 0) violations.push(`${warmupErrors} warm-up request(s) were not 200`);
    if (non200.length > 0) {
      const first = non200[0]!;
      violations.push(`${non200.length} non-2xx responses (first: status ${first.status})`);
    }
    const fiveXX = samples.filter((s) => s.status >= 500).length;
    if (fiveXX > 0) violations.push(`${fiveXX} 5xx responses`);
    const errorRate = samples.length > 0 ? errors / samples.length : 1;
    if (errorRate > MAX_ERROR_RATE) violations.push(`error rate ${(errorRate * 100).toFixed(3)}% exceeds ${MAX_ERROR_RATE * 100}%`);
    violations.push(...plan.verify(samples, { level, n, providerCalls, metrics: metricsSnap }));
    if (providerCalls !== plan.expectedProviderCalls) {
      violations.push(`provider calls=${providerCalls}, expected ${plan.expectedProviderCalls}`);
    }
    if (replay.status !== 200 || !(replay.cache === "HIT" || replay.cache === "SEMANTIC_HIT")) {
      violations.push(`post-measurement replay expected 200 HIT/SEMANTIC_HIT, got ${replay.status} ${replay.cache || "<none>"}`);
    }
    if (extraProviderCalls !== 0) violations.push(`post-measurement replay made ${extraProviderCalls} provider call(s), expected 0`);

    const latencies = samples.map((s) => s.wallMs);
    return {
      scenario: scenario.id,
      level,
      repeat,
      n: samples.length,
      setup_ms: round(setupMs),
      warmup_ms: round(warmupMs),
      measured_ms: round(measuredMs),
      ok: samples.length - errors,
      errors,
      error_rate: round(errorRate, 6),
      verdict_counts: verdictCountsOf(samples),
      provider_calls: providerCalls,
      expected_provider_calls: plan.expectedProviderCalls,
      latencies,
      latency: latencyStats(latencies),
      rps: round(samples.length / Math.max(0.001, measuredMs / 1000)),
      memory: {
        rss_before_mb: memBefore.rss_mb,
        rss_after_mb: memAfter.rss_mb,
        heap_before_mb: memBefore.heap_used_mb,
        heap_after_mb: memAfter.heap_used_mb,
        rss_delta_mb: round(memAfter.rss_mb - memBefore.rss_mb, 1),
        heap_delta_mb: round(memAfter.heap_used_mb - memBefore.heap_used_mb, 1),
      },
      replay: { status: replay.status, cache: replay.cache, extra_provider_calls: extraProviderCalls },
      violations,
    };
  } finally {
    await stopApp(app);
  }
}

interface Aggregate {
  scenario: string;
  level: number;
  runs: number;
  requests: number;
  latency: LatencyStats;
  avg_rps: number;
  min_rps: number;
  max_rps: number;
  error_rate: number;
  violation_runs: number;
  provider_calls: number;
  expected_provider_calls: number;
  avg_rss_delta_mb: number;
  avg_heap_delta_mb: number;
}

function aggregateRuns(scenario: string, level: number, runs: RunResult[]): Aggregate {
  const pool = runs.flatMap((r) => r.latencies);
  const requests = runs.reduce((s, r) => s + r.n, 0);
  const errors = runs.reduce((s, r) => s + r.errors, 0);
  const rpsList = runs.map((r) => r.rps);
  return {
    scenario,
    level,
    runs: runs.length,
    requests,
    latency: latencyStats(pool),
    avg_rps: round(rpsList.reduce((s, v) => s + v, 0) / Math.max(1, rpsList.length)),
    min_rps: round(Math.min(...rpsList)),
    max_rps: round(Math.max(...rpsList)),
    error_rate: requests > 0 ? round(errors / requests, 6) : 0,
    violation_runs: runs.filter((r) => r.violations.length > 0).length,
    provider_calls: runs.reduce((s, r) => s + r.provider_calls, 0),
    expected_provider_calls: runs.reduce((s, r) => s + r.expected_provider_calls, 0),
    avg_rss_delta_mb: round(runs.reduce((s, r) => s + r.memory.rss_delta_mb, 0) / Math.max(1, runs.length), 1),
    avg_heap_delta_mb: round(runs.reduce((s, r) => s + r.memory.heap_delta_mb, 0) / Math.max(1, runs.length), 1),
  };
}

function fmt(n: number, digits = 2): string {
  return bounded(n).toFixed(digits);
}

function runLine(r: RunResult): string {
  return (
    `  r${r.repeat}/${N_REPEATS} c=${String(r.level).padEnd(3)} n=${String(r.n).padEnd(4)} ok=${String(r.ok).padEnd(4)} err=${String(r.errors).padEnd(3)}` +
    ` rps=${fmt(r.rps, 0).padStart(6)} p50=${fmt(r.latency.p50_ms).padStart(7)} p95=${fmt(r.latency.p95_ms).padStart(7)} p99=${fmt(r.latency.p99_ms).padStart(7)} ms` +
    ` | calls=${r.provider_calls}/${r.expected_provider_calls}` +
    ` | rss ${fmt(r.memory.rss_before_mb, 0)}->${fmt(r.memory.rss_after_mb, 0)} MB (${r.memory.rss_delta_mb >= 0 ? "+" : ""}${fmt(r.memory.rss_delta_mb, 1)})` +
    ` heap (${r.memory.heap_delta_mb >= 0 ? "+" : ""}${fmt(r.memory.heap_delta_mb, 1)} MB)`
  );
}

function aggregateLine(a: Aggregate): string {
  return (
    `  AGG c=${String(a.level).padEnd(3)} runs=${a.runs} req=${a.requests} p50=${fmt(a.latency.p50_ms).padStart(7)} p95=${fmt(a.latency.p95_ms).padStart(7)} p99=${fmt(a.latency.p99_ms).padStart(7)} ms` +
    ` mean_rps=${fmt(a.avg_rps, 0).padStart(6)} err=${fmt(a.error_rate * 100, 3)}% calls=${a.provider_calls}/${a.expected_provider_calls}` +
    ` avg_rss_delta=${a.avg_rss_delta_mb >= 0 ? "+" : ""}${fmt(a.avg_rss_delta_mb, 1)} MB avg_heap_delta=${a.avg_heap_delta_mb >= 0 ? "+" : ""}${fmt(a.avg_heap_delta_mb, 1)} MB`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ScenarioJson {
  id: string;
  title: string;
  semantic: boolean;
  mock_delay_ms: number;
  n_per_run: number | string;
  levels: number[];
  runs: Omit<RunResult, "latencies">[];
  aggregate_by_level: Aggregate[];
  aggregate: Aggregate;
}

async function main(): Promise<number> {
  // The gateway logs one JSON line per request through console.log. Silence it
  // for the run: this measures the serving path, not stdout I/O. Our own output
  // bypasses console.* via emit() so BENCH_JSON stays machine-readable.
  console.log = () => undefined;

  const startedAt = new Date();
  const startedHr = performance.now();
  const machine = {
    node: process.version,
    platform: process.platform,
    os_type: type(),
    os_release: release(),
    arch: process.arch,
    cpu_model: cpus()[0]?.model ?? "unknown",
    cpu_count: cpus().length,
    total_mem_mb: Math.round(totalmem() / (1024 * 1024)),
    date: startedAt.toISOString(),
  };
  const gitHead = git(["rev-parse", "HEAD"]);
  const gitShort = git(["rev-parse", "--short", "HEAD"]);
  const gitStatus = git(["status", "--porcelain"]);
  const dirtyCount = gitStatus === null || gitStatus === "" ? 0 : gitStatus.split("\n").length;
  const packages: Record<string, string | null> = {};
  for (const name of ["fastify", "ioredis", "pg", "zod", "@huggingface/transformers", "tsx", "typescript", "vitest"]) {
    packages[name] = pkgVersion(name);
  }

  const scenarios = allScenarios();
  emit("Relay perf benchmark — hermetic, real Fastify app on a loopback socket, mock provider");
  emit(`command: npx tsx scripts/bench/perf.ts${QUICK ? " --quick" : ""}   HEAD: ${gitShort ?? "unknown"}   working-tree changes: ${dirtyCount}`);
  emit(
    `machine: node ${machine.node} · ${machine.platform}/${machine.arch} (${machine.os_type} ${machine.os_release}) · ${machine.cpu_count} CPUs · ${machine.cpu_model} · ${machine.total_mem_mb} MiB RAM`,
  );
  emit(`note:    ${NOTE}`);
  emit(
    `config:  n=${N_REQUESTS}/run (stampede: burst size 50/100) · repeats=${N_REPEATS} · concurrency=${CONCURRENCY_LEVELS.join(",")} · warmup=${WARMUP} · provider delay ${MOCK_DELAY_MS} ms (stampede ${STAMPEDE_DELAY_MS} ms) · cache=memory · semantic=memory-vector+mock (off for unique/LRU + mixed miss scenarios) · seeded registered lane`,
  );
  emit("");

  // Wiring smoke: the same app composition every scenario uses, validated once.
  {
    const smoke = await startApp({ semantic: true, mockDelayMs: 0 });
    try {
      const health = await getJson<{ provider: string; cache: string; semantic: string; embedder: string; config: { semanticThreshold: number } }>(
        `${smoke.url}/health`,
      );
      checks.push({
        name: "wiring: mock provider + memory cache + memory vector store + mock embedder + seeded lane",
        ok:
          health.provider === "mock" &&
          health.cache === "memory" &&
          health.semantic === "memory-vector" &&
          health.embedder === "mock" &&
          health.config.semanticThreshold === 0.92,
        expected: "mock/memory/memory-vector/mock threshold 0.92",
        actual: `${health.provider}/${health.cache}/${health.semantic}/${health.embedder} threshold ${health.config.semanticThreshold}`,
      });
      const probe = await postChat(smoke.url, KEY, userBody("perf-smoke", `wiring probe ${startedAt.toISOString()}`));
      const replay = await postChat(smoke.url, KEY, userBody("perf-smoke", `wiring probe ${startedAt.toISOString()}`));
      checks.push({
        name: "wiring: seeded registered lane serves a MISS then an exact HIT over the loopback socket",
        ok: probe.status === 200 && probe.cache === "MISS" && replay.status === 200 && replay.cache === "HIT",
        expected: "200 MISS then 200 HIT",
        actual: `${probe.status} ${probe.cache} then ${replay.status} ${replay.cache}`,
      });
    } finally {
      await stopApp(smoke);
    }
  }

  const scenarioJson: ScenarioJson[] = [];
  const allRuns: RunResult[] = [];

  for (const scenario of scenarios) {
    emit(`== ${scenario.id} — ${scenario.title} ==`);
    const runs: RunResult[] = [];
    const aggregates: Aggregate[] = [];
    for (const level of scenario.levels) {
      for (let repeat = 1; repeat <= N_REPEATS; repeat++) {
        const run = await runOnce(scenario, level, repeat);
        runs.push(run);
        allRuns.push(run);
        emit(runLine(run));
        checks.push({
          name: `${scenario.id} c=${level} r=${repeat}: hard expectations`,
          ok: run.violations.length === 0,
          expected: "clean run",
          actual: run.violations.length === 0 ? "clean" : run.violations.join("; "),
        });
      }
      const agg = aggregateRuns(scenario.id, level, runs.filter((r) => r.level === level));
      aggregates.push(agg);
      emit(aggregateLine(agg));
      checks.push({
        name: `${scenario.id} c=${level}: aggregate`,
        ok: agg.error_rate === 0 && agg.violation_runs === 0 && agg.provider_calls === agg.expected_provider_calls,
        expected: "0 errors, 0 violation runs, provider calls == expected",
        actual: `err=${agg.error_rate * 100}%, violation_runs=${agg.violation_runs}, calls=${agg.provider_calls}/${agg.expected_provider_calls}`,
      });
    }
    const scenarioAgg = aggregateRuns(
      scenario.id,
      0,
      runs,
    );
    emit(
      `  ALL     req=${scenarioAgg.requests} p50=${fmt(scenarioAgg.latency.p50_ms)} p95=${fmt(scenarioAgg.latency.p95_ms)} p99=${fmt(scenarioAgg.latency.p99_ms)} ms · mean_rps=${fmt(scenarioAgg.avg_rps, 0)} · err=${fmt(scenarioAgg.error_rate * 100, 3)}%`,
    );
    emit("");
    scenarioJson.push({
      id: scenario.id,
      title: scenario.title,
      semantic: scenario.semantic,
      mock_delay_ms: scenario.mockDelayMs,
      n_per_run: scenario.id === "concurrent_identical" ? "burst size (50/100)" : scenario.nForLevel(1),
      levels: scenario.levels,
      runs: runs.map(({ latencies: _latencies, ...rest }) => rest),
      aggregate_by_level: aggregates,
      aggregate: scenarioAgg,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  const elapsedS = round((performance.now() - startedHr) / 1000, 1);
  emit("== Summary ==");
  emit(`  checks: ${checks.length - failed.length}/${checks.length} passed · total measured requests: ${allRuns.reduce((s, r) => s + r.n, 0)} · window ${elapsedS} s`);
  emit(`  request-path verdicts pooled: ${JSON.stringify(poolVerdicts(allRuns))}`);
  for (const f of failed) emit(`  FAIL: ${f.name} — expected ${f.expected}, got ${f.actual}`);
  emit("");
  emit("README-ready: npx tsx scripts/bench/perf.ts  (hermetic; no external network; BENCH_JSON on stdout; non-zero exit on hard failures)");
  emit("");

  const result = {
    tool: "perf",
    note: NOTE,
    command: `npx tsx scripts/bench/perf.ts${QUICK ? " --quick" : ""}`,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    runtime_s: elapsedS,
    commit: { head: gitHead, short: gitShort, working_tree_change_count: dirtyCount },
    environment: { machine, packages },
    config: {
      provider: "mock",
      mock_delay_ms: MOCK_DELAY_MS,
      stampede_delay_ms: STAMPEDE_DELAY_MS,
      cache: "memory",
      semantic_store: "memory-vector",
      embedder: "mock",
      semantic_threshold: 0.92,
      semantic_disabled_for: ["exact_miss", "unique_no_cache", "mixed_70_30"],
      requests_per_run: N_REQUESTS,
      stampede_burst_sizes: [...STAMPEDE_SIZES],
      repeats: N_REPEATS,
      concurrency_levels: CONCURRENCY_LEVELS,
      warmup_requests: WARMUP,
      seeded_registered_lane: true,
      max_error_rate: MAX_ERROR_RATE,
    },
    scenarios: scenarioJson,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, expected: c.expected, actual: c.actual })),
    caveats: [
      NOTE,
      "Hermetic: in-process Fastify app on a real 127.0.0.1 loopback socket driven by Node fetch (undici keep-alive), no app.inject, no vitest, no external network; all live provider credentials are empty.",
      "Semantic/cache paths use InMemoryCache + InMemoryVectorStore + MockEmbedding; they measure gateway orchestration and cache mechanics, not Redis, pgvector, or an embedding provider.",
      "Semantic lookups are disabled for exact_miss/unique_no_cache/mixed so the in-memory top-K scan (O(rows)) does not dominate a MISS measurement; semantic HIT is measured in its own scenario.",
      "The 500-entry LRU in unique_no_cache deliberately exercises eviction/eviction-free admission under high cardinality; misses are expected for every unique prompt.",
      "Client RTT includes loopback socket + fetch scheduling; concurrency levels >1 include queueing, which is the point of the level. Percentiles are nearest-rank order statistics.",
      "Each per-run row seeds fresh state; setup and warm-up time are reported separately and excluded from req/s and latency.",
      "Mock provider adds a fixed 2 ms (10 ms stampede) delay: numbers are a lower bound for a real upstream and are not a live-provider benchmark.",
    ],
    passed: failed.length === 0,
    check_failures: failed.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`),
  };

  emit(`BENCH_JSON ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  return failed.length === 0 ? 0 : 1;
}

function poolVerdicts(runs: RunResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of runs) {
    for (const [verdict, count] of Object.entries(run.verdict_counts)) {
      counts[verdict] = (counts[verdict] ?? 0) + count;
    }
  }
  return counts;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });

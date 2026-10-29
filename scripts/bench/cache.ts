// scripts/bench/cache.ts — `npm run bench`
//
// Reproducible, hermetic benchmark for Relay's caching claims (README
// "Measured performance", "Long-context" table). It boots the real Fastify
// app in-process with the real route/guard/cache/policy stack, listens on a
// real loopback socket (port 0) and drives it with fetch — no app.inject, no
// vitest, no external network.
//
// Wiring under test:
//   provider     = MockProvider({ delayMs: 50 })   (simulated upstream latency)
//   exact cache  = InMemoryCache
//   semantic     = InMemoryVectorStore + real LocalEmbedding (ONNX, ./.cache)
//   auth         = seeded registered lane(s) in InMemoryApiKeyStore
//   threshold    = 0.80 (README-recommended range for the local embedder)
//
// Every phase resets the metrics counters, then reads them back over HTTP from
// GET /metrics (the same endpoint operators use). Provider calls are also
// counted independently by instrumenting MockProvider.chat, so the /metrics
// provider_requests counter is cross-checked rather than trusted.
//
// Output: human-readable table on stdout + one machine-readable line prefixed
// `BENCH_JSON ` at the end. Exit code is 1 if any hard expectation fails (a
// false cache verdict, a 5xx, a wrong provider-call count, hash instability);
// latency numbers are reported as measured and never tuned to a target.

import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { cpus, totalmem } from "node:os";
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
import { LocalEmbedding } from "../../src/embeddings/LocalEmbedding.js";
import { loadConfig, type GatewayConfig } from "../../src/infrastructure/config.js";
import type { MetricsSnapshot } from "../../src/observability/metrics.js";
import { metrics } from "../../src/observability/metrics.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";
import { createProviderFromEnv } from "../../src/providers/factory.js";

// ---------------------------------------------------------------------------
// Fixed configuration — dev-only, memory-only, hermetic.
// ---------------------------------------------------------------------------

const COMMAND = "npm run bench";
const MOCK_DELAY_MS = 50;
const NOTE = "mock provider 50ms simulated latency — lower bound, not a live-provider benchmark";

const TENANT_A = "bench";
const TENANT_B = "bench-b";
// Deterministic dev keys: any non-empty string verifies via the hashed store;
// the lg_ prefix mirrors real issued keys.
const KEY_A = "lg_bench_0123456789abcdef0123456789abcdefa1";
const KEY_B = "lg_bench_0123456789abcdef0123456789abcdefb2";

// Each phase gets its own model id where the semantic layer could otherwise
// short-circuit what the phase is measuring: semantic candidate lookup is
// scoped by (tenant, provider, model), so distinct ids make the exact-cache
// phases independent of semantic rows left by other phases/reruns.
const MODEL = "bench-exact";
const SEM_MODEL = "bench-sem";
const DEGRADE_MODEL = "bench-degrade";
const LARGE_MODEL = "bench-large";
const REPLAY_MODEL = "bench-replay";

// Semantically distinct topics — deliberately far apart, so each cold ask is a
// genuine full MISS (identical/near-identical wording would be reused by the
// semantic layer, which is exactly what phase 3 measures separately).
const MISS_TOPICS = [
  "How do I bake a naturally leavened sourdough rye bread?",
  "Why did the Western Roman Empire collapse in the fifth century?",
  "What is the correct way to tune a six-string acoustic guitar?",
  "How does quantum entanglement violate Bell inequalities?",
  "Which hiking trails in Norway stay open in late autumn?",
] as const;

const BENCH_ENV: Record<string, string> = {
  PROVIDER: "mock",
  CACHE_ENABLED: "true",
  CACHE_TTL_S: "3600",
  REDIS_URL: "",
  SEMANTIC_ENABLED: "true",
  SEMANTIC_STORE: "memory",
  SEMANTIC_THRESHOLD: "0.80",
  SEMANTIC_TOP_K: "3",
  SEMANTIC_TTL_S: "3600",
  EMBEDDING_PROVIDER: "local",
  GATEWAY_API_KEYS: `${TENANT_A}:mock:bench-a:${KEY_A},${TENANT_B}:mock:bench-b:${KEY_B}`,
  DATABASE_URL: "",
  CRED_ENC_KEY: "",
  UPSTREAM_TIMEOUT_MS: "5000",
  SAVED_USD_PER_1K_TOKENS: "0",
  // Live credentials stay empty even if the shell/.env defines them: this run
  // must never be able to reach a real provider.
  GEMINI_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPEN_ROUTER_KEY: "",
};

const PAIRS = [
  "What is the capital of France?",
  "Which city is the capital of France?",
  "How do I bake sourdough bread?",
] as const;

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

function check(name: string, ok: boolean, expected: string, actual: string): void {
  checks.push({ name, ok, expected, actual });
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

interface LatencyStats {
  n: number;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  p95_method: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] as number;
}

function stats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    avg_ms: round(avg),
    median_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    min_ms: round(sorted[0] as number),
    max_ms: round(sorted[sorted.length - 1] as number),
    p95_method: "nearest-rank",
  };
}

function boundedMax(n: number, cap: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(cap, n)) : 0;
}

function fmt(n: number): string {
  return boundedMax(n, 1e9).toFixed(2);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP client (real socket, keep-alive via undici fetch)
// ---------------------------------------------------------------------------

interface ChatBody {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
}

interface ChatApiResponse {
  choices?: { message?: { content?: string } }[];
}

interface ChatResult {
  status: number;
  wallMs: number;
  cache: string;
  coalesced: string;
  provider: string;
  cacheHash: string;
  gatewayLatencyMs: number | undefined;
  similarity: number | undefined;
  content: string;
  ok: boolean;
}

function headerNumber(res: Response, name: string): number | undefined {
  const raw = res.headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
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
    cacheHash: res.headers.get("x-cache-hash") ?? "",
    gatewayLatencyMs: headerNumber(res, "x-latency-ms"),
    similarity: headerNumber(res, "x-semantic-similarity"),
    content: parsed?.choices?.[0]?.message?.content ?? "",
    ok: res.status === 200,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

function getMetrics(url: string): Promise<MetricsSnapshot> {
  return getJson<MetricsSnapshot>(`${url}/metrics`);
}

// ---------------------------------------------------------------------------
// App builder: the real composition root, in-process.
// ---------------------------------------------------------------------------

interface BenchApp {
  app: FastifyInstance;
  cfg: GatewayConfig;
  provider: ProviderAdapter;
  cache: CacheRepository;
  semanticStore: InMemoryVectorStore;
  embedder: LocalEmbedding;
  url: string;
}

interface StartAppOptions {
  cfg: GatewayConfig;
  embedder: LocalEmbedding;
  provider: ProviderAdapter;
  cache?: CacheRepository;
  semanticStore?: InMemoryVectorStore;
}

async function startApp(opts: StartAppOptions): Promise<BenchApp> {
  const { cfg } = opts;
  const app = Fastify({ logger: false });
  const providers = new Map<string, ProviderAdapter>([["mock", opts.provider]]);
  const cache: CacheRepository = opts.cache ?? new InMemoryCache();
  const semanticStore = opts.semanticStore ?? new InMemoryVectorStore();
  const auth = {
    apiKeys: new InMemoryApiKeyStore(cfg.gatewayApiKeys),
    credentials: new InMemoryCredentialStore(new CredentialCipher(cfg.credEncKey)),
  };
  registerChatRoutes(app, opts.provider, cfg, cache, { semanticStore, embedder: opts.embedder, providers, auth });
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
    provider: opts.provider,
    cache,
    semanticStore,
    embedder: opts.embedder,
    url: `http://127.0.0.1:${address.port}`,
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

/** Throwing cache backend: every operation fails, as a dead Redis/pg would. */
class ThrowingCache implements CacheRepository {
  readonly name = "throwing";
  async get(_key: string): Promise<string | null> {
    throw new Error("bench: cache backend unavailable (get)");
  }
  async set(_key: string, _value: string, _ttlSeconds: number): Promise<void> {
    throw new Error("bench: cache backend unavailable (set)");
  }
  async del(_key: string): Promise<void> {
    throw new Error("bench: cache backend unavailable (del)");
  }
  async ping(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/** Deterministic multi-KB prompt, unique per marker and filler family. */
function largePrompt(targetBytes: number, marker: string, filler: string): string {
  let out = `large payload ${marker}. `;
  while (Buffer.byteLength(out, "utf8") < targetBytes) out += filler;
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // The gateway logs one JSON line per request through console.log. Silence it
  // for the run: this measures the serving path, not stdout I/O. Our own output
  // bypasses console.* via emit() so BENCH_JSON stays machine-readable.
  console.log = () => undefined;

  const runStartedAt = new Date();
  const runMarker = runStartedAt.toISOString();
  const machine = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemMb: Math.round(totalmem() / (1024 * 1024)),
    date: runStartedAt.toISOString(),
  };
  const gitHead = git(["rev-parse", "HEAD"]);
  const gitShort = git(["rev-parse", "--short", "HEAD"]);
  const gitStatus = git(["status", "--porcelain"]);
  const dirtyCount = gitStatus === null || gitStatus === "" ? 0 : gitStatus.split("\n").length;

  emit("Relay cache benchmark — hermetic, real Fastify app on a loopback socket");
  emit(`command: ${COMMAND}   HEAD: ${gitShort ?? "unknown"}   working-tree changes: ${dirtyCount}`);
  emit(`machine: node ${machine.node} · ${machine.platform}/${machine.arch} · ${machine.cpuCount} CPUs · ${machine.cpuModel} · ${machine.totalMemMb} MiB RAM`);
  emit(`note:    ${NOTE}`);
  emit("");

  emit("[bench] warming the built-in local ONNX embedder (cached Xenova/all-mpnet-base-v2, q8) ...");
  const embedder = new LocalEmbedding();
  const embedderWarmStart = performance.now();
  await embedder.embed("user: bench embedder warmup", AbortSignal.timeout(300_000));
  const embedderWarmupMs = round(performance.now() - embedderWarmStart);
  emit(`[bench] embedder warm in ${fmt(embedderWarmupMs)} ms (one-time model load)`);

  const cfg = loadConfig(BENCH_ENV as NodeJS.ProcessEnv);
  const providerA = createProviderFromEnv(cfg, { delayMs: MOCK_DELAY_MS });
  const providerCalls = instrumentProvider(providerA);

  let appA: BenchApp | undefined;
  let appB: BenchApp | undefined;
  try {
    appA = await startApp({ cfg, embedder, provider: providerA });
    const mainUrl = appA.url;

    const health = await getJson<{
      provider: string;
      cache: string;
      semantic: string;
      embedder: string;
      config: { semanticThreshold: number };
    }>(`${appA.url}/health`);
    check(
      "wiring: mock provider + memory cache + memory vector store + local ONNX embedder",
      health.provider === "mock" && health.cache === "memory" && health.semantic === "memory-vector" && health.embedder === "local",
      "mock/memory/memory-vector/local",
      `${health.provider}/${health.cache}/${health.semantic}/${health.embedder}`,
    );
    check(
      "wiring: semantic threshold is 0.80",
      health.config.semanticThreshold === 0.8,
      "0.8",
      String(health.config.semanticThreshold),
    );
    emit(`[bench] app ready at ${appA.url} (provider=mock +${MOCK_DELAY_MS}ms · cache=memory · semantic=memory-vector · threshold=0.80)`);
    emit("");

    // ------------------------------------------------------------------
    // Phase 1 — exact cache: HIT n=20, MISS n=5 (unique prompts)
    // ------------------------------------------------------------------
    emit("== Phase 1: exact cache — HIT vs MISS (mock provider, 50 ms simulated upstream) ==");
    const hitPrompt = `bench exact hit ${runMarker}: what does the relay request pipeline do on a repeated prompt?`;
    const seed = await postChat(appA.url, KEY_A, { model: MODEL, messages: [{ role: "user", content: hitPrompt }] });
    check("phase1 seed request: first ask is a MISS", seed.status === 200 && seed.cache === "MISS", "200 MISS", `${seed.status} ${seed.cache}`);
    // Untimed warm-up hits: establishes the keep-alive socket + JIT/HIT path.
    for (let i = 0; i < 3; i++) await postChat(appA.url, KEY_A, { model: MODEL, messages: [{ role: "user", content: hitPrompt }] });

    metrics.reset();
    const callsAtReset1 = providerCalls();
    const m1Before = await getMetrics(appA.url);
    const hitSamples: number[] = [];
    const hitGatewaySamples: number[] = [];
    let hitsAllHit = true;
    for (let i = 0; i < 20; i++) {
      const r = await postChat(appA.url, KEY_A, { model: MODEL, messages: [{ role: "user", content: hitPrompt }] });
      hitSamples.push(r.wallMs);
      if (r.gatewayLatencyMs !== undefined) hitGatewaySamples.push(r.gatewayLatencyMs);
      if (!(r.ok && r.cache === "HIT")) hitsAllHit = false;
    }
    const missSamples: number[] = [];
    const missGatewaySamples: number[] = [];
    let missesMissCount = 0;
    for (const topic of MISS_TOPICS) {
      const r = await postChat(appA.url, KEY_A, { model: MODEL, messages: [{ role: "user", content: topic }] });
      missSamples.push(r.wallMs);
      if (r.gatewayLatencyMs !== undefined) missGatewaySamples.push(r.gatewayLatencyMs);
      if (r.ok && r.cache === "MISS") missesMissCount += 1;
    }
    const missesAllMiss = missesMissCount === MISS_TOPICS.length;
    const m1After = await getMetrics(appA.url);
    const providerDelta1 = m1After.provider_requests - m1Before.provider_requests;
    const instrumented1 = providerCalls() - callsAtReset1;
    const callsAvoided1 = m1After.requests_total - m1After.provider_requests;
    // Harness-validity probe: prove the five cold asks are semantically distinct,
    // so a MISS can only come from genuinely new content (not semantic reuse).
    const missTopicVectors = await Promise.all(
      MISS_TOPICS.map((topic) => embedder.embed(`user: ${topic}`, AbortSignal.timeout(60_000))),
    );
    let missTopicMaxCosine = 0;
    for (let i = 0; i < missTopicVectors.length; i++) {
      for (let j = i + 1; j < missTopicVectors.length; j++) {
        missTopicMaxCosine = Math.max(missTopicMaxCosine, cosine(missTopicVectors[i] as number[], missTopicVectors[j] as number[]));
      }
    }
    const missTopicMaxCosineRounded = round(missTopicMaxCosine, 4);
    check(
      "phase1: cold-miss topics are semantically distinct (max pairwise cosine < 0.80)",
      missTopicMaxCosineRounded < 0.8,
      "< 0.80",
      String(missTopicMaxCosineRounded),
    );
    const hitStats = stats(hitSamples);
    const hitGatewayStats = stats(hitGatewaySamples);
    const missStats = stats(missSamples);
    const missGatewayStats = stats(missGatewaySamples);
    check("phase1: all 20 identical asks are exact HITs", hitsAllHit, "20 HITs", `${hitSamples.length} samples`);
    check("phase1: all 5 distinct-topic asks are MISSes", missesAllMiss, "5 MISSes", `${missesMissCount}/${MISS_TOPICS.length} MISSes`);
    check("phase1: provider called once per MISS", providerDelta1 === 5, "5", String(providerDelta1));
    check("phase1: instrumented adapter calls agree with /metrics", instrumented1 === providerDelta1, String(providerDelta1), String(instrumented1));
    check("phase1: 20 of 25 in-window requests avoided a provider call", callsAvoided1 === 20, "20", String(callsAvoided1));
    check("phase1: /metrics exact_hits == 20", m1After.exact_hits === 20, "20", String(m1After.exact_hits));
    emit(`  HIT   n=20  client RTT: avg ${fmt(hitStats.avg_ms)} ms · median ${fmt(hitStats.median_ms)} · p95 ${fmt(hitStats.p95_ms)} (nearest-rank) · min ${fmt(hitStats.min_ms)} · max ${fmt(hitStats.max_ms)}`);
    emit(`  HIT   n=20  gateway x-latency-ms: avg ${fmt(hitGatewayStats.avg_ms)} ms · p95 ${fmt(hitGatewayStats.p95_ms)}`);
    emit(`  MISS  n=5   client RTT: avg ${fmt(missStats.avg_ms)} ms · median ${fmt(missStats.median_ms)} · p95 ${fmt(missStats.p95_ms)} · min ${fmt(missStats.min_ms)} · max ${fmt(missStats.max_ms)}`);
    emit(`  MISS  n=5   gateway x-latency-ms: avg ${fmt(missGatewayStats.avg_ms)} ms · median ${fmt(missGatewayStats.median_ms)}`);
    emit(`  provider calls: ${providerDelta1} (instrumented ${instrumented1}) · calls avoided: ${callsAvoided1} of ${m1After.requests_total} requests`);
    emit(`  cold-miss topics: max pairwise cosine ${missTopicMaxCosineRounded.toFixed(4)} (< 0.80, so none was a semantic rewrite of another)`);
    emit("");

    // ------------------------------------------------------------------
    // Phase 2 — 50 concurrent identical cold misses -> how many provider calls?
    // ------------------------------------------------------------------
    emit("== Phase 2: single-flight stampede — 50 concurrent identical cold asks ==");
    metrics.reset();
    const callsAtReset2 = providerCalls();
    const stampedePrompt = `bench stampede ${runMarker}: one cold prompt presented 50 times at the same instant.`;
    const stampedeStart = performance.now();
    const stampedeResults = await Promise.all(
      Array.from({ length: 50 }, () => postChat(mainUrl, KEY_A, { model: MODEL, messages: [{ role: "user", content: stampedePrompt }] })),
    );
    const stampedeWallMs = round(performance.now() - stampedeStart);
    const m2 = await getMetrics(appA.url);
    const instrumented2 = providerCalls() - callsAtReset2;
    const stampedeCalls = m2.provider_requests;
    const verdictCounts: Record<string, number> = {};
    for (const r of stampedeResults) verdictCounts[r.cache] = (verdictCounts[r.cache] ?? 0) + 1;
    const coalescedHeaders = stampedeResults.filter((r) => r.coalesced === "true").length;
    const all200 = stampedeResults.every((r) => r.ok);
    const uniqueAnswers = new Set(stampedeResults.map((r) => r.content)).size;
    check("phase2: all 50 requests return 200", all200, "50 x 200", `${stampedeResults.filter((r) => r.ok).length} x 200`);
    check("phase2: exactly one provider call", stampedeCalls === 1, "1", String(stampedeCalls));
    check("phase2: one single-flight leader", m2.singleflight_leaders === 1, "1", String(m2.singleflight_leaders));
    check("phase2: every non-leader is coalesced or served from the exact cache", m2.singleflight_coalesced + m2.exact_hits === 49, "49", String(m2.singleflight_coalesced + m2.exact_hits));
    check("phase2: all 50 clients receive the same answer text", uniqueAnswers === 1, "1 unique answer", `${uniqueAnswers} unique answers`);
    emit(`  50 concurrent asks -> ${stampedeCalls} provider call(s) (instrumented ${instrumented2}) · wall ${fmt(stampedeWallMs)} ms`);
    emit(`  x-cache verdicts: ${Object.entries(verdictCounts).map(([k, v]) => `${k}=${v}`).join(" · ")} · x-coalesced:true headers: ${coalescedHeaders}`);
    emit("");

    // ------------------------------------------------------------------
    // Phase 3 — semantic reuse and its safety policy
    // ------------------------------------------------------------------
    emit("== Phase 3: semantic cache — paraphrase reuse, policy misses (real ONNX embedder, threshold 0.80) ==");
    metrics.reset();
    const callsAtReset3 = providerCalls();
    const sem = { model: SEM_MODEL };
    const seedSem = await postChat(appA.url, KEY_A, { ...sem, messages: [{ role: "user", content: PAIRS[0] }] });
    const para = await postChat(appA.url, KEY_A, { ...sem, messages: [{ role: "user", content: PAIRS[1] }] });
    const unrelated = await postChat(appA.url, KEY_A, { ...sem, messages: [{ role: "user", content: PAIRS[2] }] });
    const tempDrift = await postChat(appA.url, KEY_A, { ...sem, temperature: 0.5, messages: [{ role: "user", content: PAIRS[1] }] });
    const foreign = await postChat(appA.url, KEY_B, { ...sem, messages: [{ role: "user", content: PAIRS[1] }] });
    const m3 = await getMetrics(appA.url);
    const providerDelta3 = m3.provider_requests;
    const instrumented3 = providerCalls() - callsAtReset3;
    check("phase3: seed question is a MISS", seedSem.ok && seedSem.cache === "MISS", "200 MISS", `${seedSem.status} ${seedSem.cache}`);
    check("phase3: paraphrase is a SEMANTIC_HIT", para.ok && para.cache === "SEMANTIC_HIT", "200 SEMANTIC_HIT", `${para.status} ${para.cache}`);
    check("phase3: paraphrase similarity is reported and >= threshold", (para.similarity ?? 0) >= 0.8, ">= 0.80", String(para.similarity ?? "absent"));
    check("phase3: semantic hit reuses the cached answer text", para.content !== "" && para.content === seedSem.content, "same content", para.content === seedSem.content ? "same" : "different");
    check("phase3: unrelated question is a MISS", unrelated.ok && unrelated.cache === "MISS", "200 MISS", `${unrelated.status} ${unrelated.cache}`);
    check("phase3: temperature-drifted paraphrase is a MISS (policy)", tempDrift.ok && tempDrift.cache === "MISS", "200 MISS", `${tempDrift.status} ${tempDrift.cache}`);
    check("phase3: second tenant's paraphrase is a MISS (tenant isolation)", foreign.ok && foreign.cache === "MISS", "200 MISS", `${foreign.status} ${foreign.cache}`);
    check("phase3: provider called for seed + unrelated + temperature drift + second tenant only", providerDelta3 === 4, "4", String(providerDelta3));
    check("phase3: instrumented adapter calls agree with /metrics", instrumented3 === providerDelta3, String(providerDelta3), String(instrumented3));
    check("phase3: /metrics semantic_hits == 1", m3.semantic_hits === 1, "1", String(m3.semantic_hits));
    check("phase3: /metrics semantic_misses == 4", m3.semantic_misses === 4, "4", String(m3.semantic_misses));

    // Direct cosine probes on the same prompt texts the route embeds
    // (promptTextForEmbedding prefixes each message with "role: ").
    const embedPair = async (text: string): Promise<number[]> => embedder.embed(`user: ${text}`, AbortSignal.timeout(60_000));
    const vecSeed = await embedPair(PAIRS[0]);
    const vecPara = await embedPair(PAIRS[1]);
    const vecUnrelated = await embedPair(PAIRS[2]);
    const simParaphrase = round(cosine(vecSeed, vecPara), 4);
    const simUnrelated = round(cosine(vecSeed, vecUnrelated), 4);
    const simIdentity = round(cosine(vecSeed, vecSeed), 4);
    check("phase3: measured cosine for the paraphrase pair clears the 0.80 threshold", simParaphrase >= 0.8, ">= 0.80", String(simParaphrase));
    check("phase3: measured cosine for the unrelated pair stays far below the threshold", simUnrelated < 0.35, "< 0.35", String(simUnrelated));

    const histogram = {
      lt_090: m3.semantic_hist_lt_090,
      "090_092": m3.semantic_hist_090_092,
      "092_095": m3.semantic_hist_092_095,
      gte_095: m3.semantic_hist_gte_095,
      avg_semantic_score: round(m3.avg_semantic_score, 4),
      scored_samples: m3.semantic_hits,
    };
    emit(`  ${"seed".padEnd(12)} MISS            provider calls +1`);
    emit(`  ${"paraphrase".padEnd(12)} ${para.cache.padEnd(15)} similarity ${para.similarity !== undefined ? para.similarity.toFixed(4) : "absent"} (threshold 0.80) · answer reused: ${para.content === seedSem.content ? "yes" : "no"}`);
    emit(`  ${"unrelated".padEnd(12)} ${unrelated.cache.padEnd(15)} no false reuse`);
    emit(`  ${"temp 0.5".padEnd(12)} ${tempDrift.cache.padEnd(15)} temperature-mismatch policy blocks reuse`);
    emit(`  ${"tenant B".padEnd(12)} ${foreign.cache.padEnd(15)} semantic tenant isolation holds`);
    emit(`  pairwise cosine probes: France/paraphrase ${simParaphrase.toFixed(4)} · France/unrelated ${simUnrelated.toFixed(4)} · identical ${simIdentity.toFixed(4)}`);
    emit(`  metrics similarity histogram (scored hits only, n=${m3.semantic_hits}): <0.90=${histogram.lt_090} · 0.90-0.92=${histogram["090_092"]} · 0.92-0.95=${histogram["092_095"]} · >=0.95=${histogram.gte_095} · avg ${histogram.avg_semantic_score.toFixed(4)}`);
    emit(`  provider calls in phase: ${providerDelta3} (instrumented ${instrumented3}) · semantic_hits ${m3.semantic_hits} · semantic_misses ${m3.semantic_misses}`);
    emit("");

    // ------------------------------------------------------------------
    // Phase 4 — cache-outage degradation: 200 + MISS + counter, never a 5xx
    // ------------------------------------------------------------------
    emit("== Phase 4: degradation — cache backend throws on every operation ==");
    appB = await startApp({ cfg, embedder, provider: createProviderFromEnv(cfg, { delayMs: MOCK_DELAY_MS }), cache: new ThrowingCache() });
    metrics.reset();
    const degradePrompt = `bench degradation ${runMarker}: the cache backend is down, the request must still succeed.`;
    const degraded = await postChat(appB.url, KEY_A, { model: DEGRADE_MODEL, messages: [{ role: "user", content: degradePrompt }] });
    const m4 = await getMetrics(appB.url);
    check("phase4: cache outage still returns 200", degraded.ok, "200", String(degraded.status));
    check("phase4: cache outage degrades to a MISS", degraded.cache === "MISS", "MISS", degraded.cache);
    check("phase4: answer is still produced by the provider", degraded.content !== "" && degraded.provider === "mock", "non-empty content from mock", degraded.content === "" ? "empty" : `content from ${degraded.provider}`);
    check("phase4: /metrics cache_lookup_failed > 0", m4.cache_lookup_failed > 0, "> 0", String(m4.cache_lookup_failed));
    check("phase4: /metrics cache_write_failed > 0", m4.cache_write_failed > 0, "> 0", String(m4.cache_write_failed));
    check("phase4: no 5xx surfaced", degraded.status < 500, "< 500", String(degraded.status));
    emit(`  throwing cache -> HTTP ${degraded.status} · x-cache ${degraded.cache} · provider ${degraded.provider} · content ${degraded.content === "" ? "empty" : "served"}`);
    emit(`  /metrics: cache_lookup_failed=${m4.cache_lookup_failed} · cache_write_failed=${m4.cache_write_failed} · provider_requests=${m4.provider_requests} · requests_total=${m4.requests_total}`);
    emit("");

    // ------------------------------------------------------------------
    // Phase 5 — 64KB payload: MISS -> HIT with a stable canonical hash
    // ------------------------------------------------------------------
    emit("== Phase 5: large payload — 64KB content MISS then HIT ==");
    metrics.reset();
    const largeContent = largePrompt(
      64 * 1024,
      runMarker,
      "The relay benchmark payload exercises canonical hashing and cache admission across large bodies; ",
    );
    const largeBytes = Buffer.byteLength(largeContent, "utf8");
    const largeMiss = await postChat(appA.url, KEY_A, { model: LARGE_MODEL, messages: [{ role: "user", content: largeContent }] });
    const largeHit = await postChat(appA.url, KEY_A, { model: LARGE_MODEL, messages: [{ role: "user", content: largeContent }] });
    const m5 = await getMetrics(appA.url);
    const hashesEqual = largeMiss.cacheHash !== "" && largeMiss.cacheHash === largeHit.cacheHash;
    check("phase5: 64KB payload exceeds 64KB", largeBytes > 64 * 1024, "> 65536 bytes", String(largeBytes));
    check("phase5: first large request is a MISS", largeMiss.ok && largeMiss.cache === "MISS", "200 MISS", `${largeMiss.status} ${largeMiss.cache}`);
    check("phase5: repeated large request is an exact HIT", largeHit.ok && largeHit.cache === "HIT", "200 HIT", `${largeHit.status} ${largeHit.cache}`);
    check("phase5: x-cache-hash identical across MISS and HIT", hashesEqual, largeMiss.cacheHash, largeHit.cacheHash);
    check("phase5: HIT returns byte-identical content", largeMiss.content === largeHit.content, "identical", largeMiss.content === largeHit.content ? "identical" : "different");
    check("phase5: exactly one provider call for the large payload", m5.provider_requests === 1, "1", String(m5.provider_requests));
    emit(`  ${(largeBytes / 1024).toFixed(1)} KB payload: MISS ${fmt(largeMiss.wallMs)} ms -> HIT ${fmt(largeHit.wallMs)} ms · hash ${largeMiss.cacheHash.slice(0, 16)}... · identical: ${largeMiss.cacheHash === largeHit.cacheHash && largeMiss.content === largeHit.content}`);
    emit(`  NOTE: the MISS is embedder-bound (local ONNX tokenization/inference on ${(largeBytes / 1024).toFixed(0)} KB text); the HIT path does not embed and shows the exact-cache cost.`);
    emit(`  provider calls: ${m5.provider_requests} (one miss; the repeat never reached the provider)`);
    emit("");

    // ------------------------------------------------------------------
    // Phase 6 — 6KB prompt: seed once, replay 40x -> still 1 provider call
    // ------------------------------------------------------------------
    emit("== Phase 6: long-context replay — one 6KB prompt, 40 exact replays ==");
    metrics.reset();
    const sixKbContent = largePrompt(
      6 * 1024,
      runMarker,
      "A long recipe note about sourdough starters, flour hydration, oven spring and crumb structure; ",
    );
    const sixKbBytes = Buffer.byteLength(sixKbContent, "utf8");
    const sixKbSeed = await postChat(appA.url, KEY_A, { model: REPLAY_MODEL, messages: [{ role: "user", content: sixKbContent }] });
    const replayStart = performance.now();
    const replays: ChatResult[] = [];
    for (let i = 0; i < 40; i++) {
      replays.push(await postChat(appA.url, KEY_A, { model: REPLAY_MODEL, messages: [{ role: "user", content: sixKbContent }] }));
    }
    const replayWallMs = round(performance.now() - replayStart);
    const replayStats = stats(replays.map((r) => r.wallMs));
    const m6 = await getMetrics(appA.url);
    const replaysAllHit = replays.every((r) => r.ok && r.cache === "HIT");
    check("phase6: 6KB seed is a MISS", sixKbSeed.ok && sixKbSeed.cache === "MISS", "200 MISS", `${sixKbSeed.status} ${sixKbSeed.cache}`);
    check("phase6: all 40 replays are HITs", replaysAllHit, "40 HITs", `${replays.filter((r) => r.cache === "HIT").length} HITs`);
    check("phase6: exactly one provider call for the 6KB prompt", m6.provider_requests === 1, "1", String(m6.provider_requests));
    check("phase6: /metrics exact_hits == 40", m6.exact_hits === 40, "40", String(m6.exact_hits));
    emit(`  ${(sixKbBytes / 1024).toFixed(1)} KB prompt: 1 MISS (${fmt(sixKbSeed.wallMs)} ms) + 40 HITs in ${fmt(replayWallMs)} ms (avg ${fmt(replayStats.avg_ms)} ms/replay)`);
    emit(`  provider calls: ${m6.provider_requests} · /metrics exact_hits: ${m6.exact_hits} · requests_total: ${m6.requests_total}`);
    emit("");

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    const failed = checks.filter((c) => !c.ok);
    emit("== Summary ==");
    emit(`  checks: ${checks.length - failed.length}/${checks.length} passed`);
    for (const f of failed) emit(`  FAIL: ${f.name} (expected ${f.expected}, got ${f.actual})`);

    const result = {
      note: NOTE,
      command: COMMAND,
      started_at: runStartedAt.toISOString(),
      finished_at: new Date().toISOString(),
      commit: { head: gitHead, short: gitShort, working_tree_change_count: dirtyCount },
      machine,
      embedder: { provider: "local", model: "Xenova/all-mpnet-base-v2", dtype: "q8", warmup_ms: embedderWarmupMs },
      config: {
        provider: "mock",
        mock_delay_ms: MOCK_DELAY_MS,
        cache: "memory",
        semantic_store: "memory-vector",
        semantic_threshold: cfg.semanticThreshold,
        semantic_top_k: cfg.semanticTopK,
        upstream_timeout_ms: cfg.upstreamTimeoutMs,
        gateway_keys: cfg.gatewayApiKeys.length,
        tenants: [TENANT_A, TENANT_B],
      },
      phases: {
        exact_cache: {
          hit: { n: hitStats.n, client_rtt: hitStats, gateway_x_latency: hitGatewayStats },
          miss: { n: missStats.n, client_rtt: missStats, gateway_x_latency: missGatewayStats, unique_prompts: MISS_TOPICS.length, max_pairwise_cosine: missTopicMaxCosineRounded },
          requests_total: m1After.requests_total,
          provider_calls: providerDelta1,
          provider_calls_instrumented: instrumented1,
          calls_avoided: callsAvoided1,
          avoided_ratio: round(callsAvoided1 / m1After.requests_total, 4),
          metrics: { exact_hits: m1After.exact_hits, exact_misses: m1After.exact_misses, provider_requests: m1After.provider_requests, provider_calls_avoided: m1After.provider_calls_avoided },
        },
        stampede: {
          n: 50,
          wall_ms: stampedeWallMs,
          cache_verdicts: verdictCounts,
          coalesced_header_true: coalescedHeaders,
          provider_calls: stampedeCalls,
          provider_calls_instrumented: instrumented2,
          singleflight_leaders: m2.singleflight_leaders,
          singleflight_coalesced: m2.singleflight_coalesced,
          exact_hits: m2.exact_hits,
          all_200: all200,
          unique_answer_texts: uniqueAnswers,
        },
        semantic: {
          threshold: cfg.semanticThreshold,
          seed: { prompt: PAIRS[0], verdict: seedSem.cache, status: seedSem.status },
          paraphrase: { prompt: PAIRS[1], verdict: para.cache, similarity: para.similarity ?? null, answer_reused: para.content !== "" && para.content === seedSem.content, provider_calls: 0 },
          unrelated: { prompt: PAIRS[2], verdict: unrelated.cache, similarity: simUnrelated },
          temperature_drift: { temperature: 0.5, verdict: tempDrift.cache, expected_policy_block: "temperature-mismatch" },
          second_tenant: { tenant: TENANT_B, verdict: foreign.cache },
          pair_probes: {
            paraphrase_cosine: simParaphrase,
            unrelated_cosine: simUnrelated,
            identical_cosine: simIdentity,
          },
          provider_calls: providerDelta3,
          provider_calls_instrumented: instrumented3,
          metrics: { semantic_hits: m3.semantic_hits, semantic_misses: m3.semantic_misses, semantic_errors: m3.semantic_errors, histogram },
        },
        degradation: {
          cache: "throwing",
          status: degraded.status,
          cache_verdict: degraded.cache,
          provider: degraded.provider,
          content_served: degraded.content !== "",
          cache_lookup_failed: m4.cache_lookup_failed,
          cache_write_failed: m4.cache_write_failed,
          provider_requests: m4.provider_requests,
          requests_total: m4.requests_total,
          any_5xx: degraded.status >= 500,
        },
        large_payload: {
          bytes: largeBytes,
          miss: { verdict: largeMiss.cache, latency_ms: round(largeMiss.wallMs), cache_hash: largeMiss.cacheHash },
          hit: { verdict: largeHit.cache, latency_ms: round(largeHit.wallMs), cache_hash: largeHit.cacheHash },
          hashes_equal: hashesEqual,
          payload_identical: largeMiss.content === largeHit.content,
          provider_requests: m5.provider_requests,
        },
        replay_6kb: {
          bytes: sixKbBytes,
          seed_verdict: sixKbSeed.cache,
          seed_latency_ms: round(sixKbSeed.wallMs),
          replays: 40,
          replays_all_hit: replaysAllHit,
          replay_wall_ms: replayWallMs,
          replay_avg_ms: replayStats.avg_ms,
          provider_requests: m6.provider_requests,
          exact_hits: m6.exact_hits,
        },
      },
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, expected: c.expected, actual: c.actual })),
      caveats: [
        NOTE,
        "Hermetic: in-process Fastify app on a real 127.0.0.1 loopback socket driven by Node fetch (undici keep-alive), no app.inject, no vitest, no external network; all upstream credentials empty.",
        "The gateway's per-request JSON logger (console.log) is silenced and Fastify logging is off; timings exclude stdout I/O that production debug logging would add.",
        "p95 is nearest-rank over the sample (n=20 -> 19th of 20 sorted samples), an order statistic, not an interpolated quantile; small n makes p95 noisy.",
        "MISS and SEMANTIC_HIT requests include real in-process ONNX inference for the local embedder (~30 ms warm for short prompts, ~0.6 s for multi-KB prompts on this machine), so they are not pure gateway overhead.",
        "Mock provider adds a fixed 50 ms: numbers are a lower bound on real-provider latency and are not a live-provider benchmark.",
        "Exact-cache phases pin a dedicated model id (and multi-KB payloads use distinct deterministic wording) so semantic rows left by another phase/rerun cannot short-circuit what that phase measures; phase 3 is the only place semantic reuse is intentionally exercised.",
        `Measured on HEAD ${gitShort ?? "unknown"} plus the uncommitted harness itself (${dirtyCount} working-tree changes); not committed/pushed.`,
        "Provider calls are counted both by /metrics and by instrumenting MockProvider.chat, and every hard expectation was asserted (false verdicts/counts exit non-zero).",
      ],
      passed: failed.length === 0,
      check_failures: failed.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`),
    };

    emit(`BENCH_JSON ${JSON.stringify(result)}`);
    // Flush stdout before the explicit exit (piped stdout is async on Windows).
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    return failed.length === 0 ? 0 : 1;
  } finally {
    await stopApp(appA);
    await stopApp(appB);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });

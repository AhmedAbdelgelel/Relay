// scripts/bench/large-context.ts — `npm run bench:large-context`
//
// Hermetic large-context cache benchmark for the TWO cache layers:
//   exact  : first MISS (provider called) -> repeated HIT (no provider call)
//   semantic: one seeded row -> SEMANTIC_HIT (no provider call)
//
// It boots the real Fastify chat route on a loopback socket and drives it with
// fetch. The provider is the in-process mock (2 ms) and the embedder is a
// deterministic constant-vector test embedder: this measures the gateway/cache
// path at large payload sizes, NOT real LLM latency and NOT real embedding
// quality. No network, no API keys, no ONNX/model download.
//
// Output: human table + `BENCH_JSON` line. Exit code 1 on wrong verdicts/errors.

import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { cpus, totalmem } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { systemFingerprint, POLICY_VERSION } from "../../src/policy/reuse.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import type { ChatRequest } from "../../src/domain/types.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { metrics } from "../../src/observability/metrics.js";

const MODEL = "mock-large-context";
const TENANT = "bench-large";
const KEY = "lg_bench_large_context_0001";
const PROVIDER_DELAY_MS = 2;
const SIZES_KB = [8, 32, 64, 128, 256] as const;
const HIT_REQUESTS = 25;
const MISS_REQUESTS = 8;
const THRESHOLD = 0.95;

const UNIT = (() => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 1;
  return v;
})();

/** Deterministic test embedder.
 * - prompts tagged "semantic" share the same unit vector (so the seeded row is
 *   a perfect semantic match without touching the exact cache);
 * - every other prompt gets a unique unit vector, so the exact-MISS scenario
 *   cannot accidentally become a semantic hit.
 */
class ConstantEmbedder implements EmbeddingProvider {
  readonly name = "bench-constant";
  readonly dimension = EMBEDDING_DIM;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    if (text.includes("semantic-")) return [...UNIT];
    const digest = createHash("sha256").update(text, "utf8").digest();
    const index = digest.readUInt32BE(0) % EMBEDDING_DIM;
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    v[index] = 1;
    return v;
  }
}

function cfg(): GatewayConfig {
  return {
    port: 0,
    provider: "mock",
    upstreamTimeoutMs: 5000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash", geminiBaseUrl: "https://example.invalid",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://example.invalid", openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://example.invalid", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://example.invalid", openRouterModel: "x/y:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: true, semanticThreshold: THRESHOLD, semanticTopK: 3, semanticTtlSec: 3600,
    semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "", savedUsdPer1kTokens: 0,
  };
}

function body(sizeKb: number, tag: string): Record<string, unknown> {
  const chunk = `large-context cache benchmark ${tag}: record ${sizeKb}KB of stable request text for exact and semantic cache paths. `;
  let text = "";
  while (text.length < sizeKb * 1024) text += chunk;
  text += ` end-${tag}-${sizeKb}`;
  return { model: MODEL, messages: [{ role: "user", content: text }], temperature: 1, stream: false };
}

function asChatRequest(payload: Record<string, unknown>): ChatRequest {
  return {
    model: String(payload["model"]),
    messages: payload["messages"] as ChatRequest["messages"],
    temperature: 1,
    stream: false,
  };
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function stats(samples: number[]): { n: number; p50: number; p95: number; p99: number; avg: number } {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    avg: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length),
  };
}

interface ScenarioResult {
  sizeKb: number;
  exactMiss: { latency: ReturnType<typeof stats>; providerCalls: number };
  exactHit: { latency: ReturnType<typeof stats>; providerCalls: number; wrongVerdicts: number };
  semanticHit: { latency: ReturnType<typeof stats>; providerCalls: number; wrongVerdicts: number };
}

interface CallResult {
  status: number;
  cache: string | null;
  latencyMs: number;
  bytes: number;
}

async function main(): Promise<number> {
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 512 * 1024 });
  const provider = new MockProvider({ delayMs: PROVIDER_DELAY_MS });
  let providerCalls = 0;
  const originalChat = provider.chat.bind(provider);
  provider.chat = (async (...args: Parameters<typeof originalChat>) => {
    providerCalls++;
    return originalChat(...args);
  }) as typeof originalChat;

  const cache = new InMemoryCache();
  const semanticStore = new InMemoryVectorStore();
  const embedder = new ConstantEmbedder();
  const apiKeys = new InMemoryApiKeyStore([{ tenant: TENANT, provider: "mock", name: "bench", key: KEY }]);
  const credentials = new InMemoryCredentialStore(new CredentialCipher("bench-large-context-secret"));

  registerChatRoutes(app, provider, cfg(), cache, {
    semanticStore,
    embedder,
    providers: new Map([["mock", provider]]),
    auth: { apiKeys, credentials },
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const auth = { authorization: `Bearer ${KEY}` };

  async function call(payload: Record<string, unknown>): Promise<CallResult> {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    const started = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { status: res.status, cache: res.headers.get("x-cache"), latencyMs: performance.now() - started, bytes: text.length };
  }

  // Silence the gateway JSON logger during measurement; final table uses emit().
  const emit = console.log.bind(console);
  console.log = () => {};
  const results: ScenarioResult[] = [];
  for (const sizeKb of SIZES_KB) {
    metrics.reset();
    providerCalls = 0;

    // exact MISS: first request (fresh prompt)
    const exactPayload = body(sizeKb, "exact");
    const missLatencies: number[] = [];
    for (let i = 0; i < MISS_REQUESTS; i++) {
      const fresh = body(sizeKb, `exact-miss-${i}`);
      const res = await call(fresh);
      if (res.status !== 200 || res.cache !== "MISS") {
        console.error(`exact MISS failed size=${sizeKb}KB status=${res.status} cache=${res.cache}`);
        await app.close();
        console.log = emit;
        return 1;
      }
      missLatencies.push(res.latencyMs);
    }
    const missCalls = providerCalls;

    // exact HIT: repeat one canonical prompt (warm once outside the measured loop)
    const warm = await call(exactPayload);
    if (warm.status !== 200 || warm.cache !== "MISS") {
      console.error(`exact warm failed size=${sizeKb}KB status=${warm.status} cache=${warm.cache}`);
      await app.close();
      console.log = emit;
      return 1;
    }
    const hitLatencies: number[] = [];
    let hitWrong = 0;
    for (let i = 0; i < HIT_REQUESTS; i++) {
      const res = await call(exactPayload);
      hitLatencies.push(res.latencyMs);
      if (res.status !== 200 || res.cache !== "HIT") hitWrong++;
    }

    // semantic HIT: seed one vector row, then send a different prompt with the
    // same deterministic vector; exact cache is empty for that prompt.
    const semanticPayload = body(sizeKb, `semantic-${sizeKb}`);
    const seedPayload = body(sizeKb, `semantic-seed-${sizeKb}`);
    const seedReq = asChatRequest(seedPayload);
    await semanticStore.save({
      tenant: TENANT,
      provider: "mock",
      model: MODEL,
      promptHash: `seed-${sizeKb}`,
      promptText: String((seedPayload["messages"] as Array<{ content: string }>)[0]!.content),
      temperature: 1,
      embedding: [...UNIT],
      content: `cached answer for ${sizeKb}KB`,
      ttlSeconds: 3600,
      systemFingerprint: systemFingerprint(seedReq),
      policyVersion: POLICY_VERSION,
    });
    const semanticLatencies: number[] = [];
    let semanticWrong = 0;
    const beforeSemantic = providerCalls;
    for (let i = 0; i < HIT_REQUESTS; i++) {
      const res = await call(semanticPayload);
      semanticLatencies.push(res.latencyMs);
      if (res.status !== 200 || res.cache !== "SEMANTIC_HIT") semanticWrong++;
    }
    const semanticCalls = providerCalls - beforeSemantic;

    results.push({
      sizeKb,
      exactMiss: { latency: stats(missLatencies), providerCalls: missCalls },
      exactHit: { latency: stats(hitLatencies), providerCalls: 0, wrongVerdicts: hitWrong },
      semanticHit: { latency: stats(semanticLatencies), providerCalls: semanticCalls, wrongVerdicts: semanticWrong },
    });
  }

  await app.close();
  console.log = emit;

  emit("large-context cache benchmark (mock provider 2 ms + deterministic test embedder 768-d)");
  emit("context | exact MISS p50/p95 | exact HIT p50/p95 | semantic HIT p50/p95 | exact-hit provider calls | semantic provider calls");
  for (const r of results) {
    emit(
      `${String(r.sizeKb).padStart(4)}KB | ${r.exactMiss.latency.p50.toFixed(1)}/${r.exactMiss.latency.p95.toFixed(1)} ms` +
        ` | ${r.exactHit.latency.p50.toFixed(1)}/${r.exactHit.latency.p95.toFixed(1)} ms` +
        ` | ${r.semanticHit.latency.p50.toFixed(1)}/${r.semanticHit.latency.p95.toFixed(1)} ms` +
        ` | ${r.exactHit.providerCalls} | ${r.semanticHit.providerCalls}`,
    );
  }
  const failures: string[] = [];
  for (const r of results) {
    if (r.exactHit.wrongVerdicts > 0) failures.push(`${r.sizeKb}KB exact HIT wrong verdicts=${r.exactHit.wrongVerdicts}`);
    if (r.semanticHit.wrongVerdicts > 0) failures.push(`${r.sizeKb}KB semantic HIT wrong verdicts=${r.semanticHit.wrongVerdicts}`);
    if (r.exactHit.providerCalls > 0) failures.push(`${r.sizeKb}KB exact HIT called the provider`);
    if (r.semanticHit.providerCalls > 0) failures.push(`${r.sizeKb}KB semantic HIT called the provider`);
  }
  const json = {
    tool: "large-context",
    note: "cache-layer measurement: mock provider (2 ms) + deterministic test embedder; NOT live LLM latency",
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      cpu_count: cpus().length,
      total_mem_mb: Math.round(totalmem() / 1024 / 1024),
    },
    config: { sizes_kb: SIZES_KB, hit_requests: HIT_REQUESTS, miss_requests: MISS_REQUESTS, semantic_threshold: THRESHOLD, provider_delay_ms: PROVIDER_DELAY_MS },
    results,
    passed: failures.length === 0,
    failures,
  };
  emit(`BENCH_JSON ${JSON.stringify(json)}`);
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });


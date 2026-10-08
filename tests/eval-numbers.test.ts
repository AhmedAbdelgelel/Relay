// tests/eval-numbers.test.ts — offline eval numbers (threshold sweep + exact latency).

import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { InMemoryCache } from "../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../src/cache/InMemoryVectorStore.js";
import {
  EMBEDDING_DIM,
  type EmbeddingProvider,
} from "../src/embeddings/EmbeddingProvider.js";
import type { GatewayConfig } from "../src/infrastructure/config.js";
import { metrics } from "../src/observability/metrics.js";
import { isReusableSemantic } from "../src/policy/reuse.js";
import { registerChatRoutes } from "../src/api/routes/chat.js";
import { MockProvider } from "../src/providers/MockProvider.js";

const DATASET_VERSION = "threshold-sweep/v1";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "eval/model:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: true, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "",
    ...over,
  };
}

function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

const REF = unit(0);
const ORTH = unit(1);

/**
 * Controlled-cosine embedder: text tagged `cos:<v>` embeds to a vector whose
 * cosine to REF is exactly v (v*REF + sqrt(1-v^2)*ORTH, both unit + orthogonal).
 * Untagged text embeds orthogonal (true negatives). Deterministic, no network.
 */
class ControlledEmbedder implements EmbeddingProvider {
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

interface Fixture { name: string; family: "paraphrase" | "near-miss" | "topical" | "unrelated"; sim: number; mustHit: boolean }

// Labeled set: positives clear the 0.92 bar with margin; the hardest
// must-MISS sits at 0.91 so the 0.90/0.92 boundary is directly probed.
const FIXTURES: Fixture[] = [
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
  { name: "neg-1", family: "unrelated", sim: 0.1, mustHit: false },
  { name: "neg-2", family: "unrelated", sim: 0.05, mustHit: false },
  { name: "neg-3", family: "unrelated", sim: 0.0, mustHit: false },
];

const FILTER = { tenant: "default", provider: "mock", model: "m" };

async function seed(store: InMemoryVectorStore): Promise<void> {
  await store.save({
    tenant: "default", provider: "mock", model: "m", promptHash: "seed",
    promptText: "seed", temperature: 1.0, maxTokens: undefined,
    embedding: REF, content: "seed answer", usage: undefined, ttlSeconds: 3600,
  });
}

interface SweepPoint { threshold: number; tp: number; fp: number; fn: number; tn: number; precision: number; recall: number }

async function sweep(store: InMemoryVectorStore, thresholds: number[]): Promise<SweepPoint[]> {
  const out: SweepPoint[] = [];
  for (const threshold of thresholds) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const f of FIXTURES) {
      const vec = await new ControlledEmbedder().embed(`cos:${f.sim}`, new AbortController().signal);
      const cands = await store.findSimilar(vec, FILTER, { threshold, topK: 3 });
      // Retrieval hit + policy gate (production path, in order).
      let reused = false;
      for (const hit of cands) {
        const d = isReusableSemantic(
          { model: "m", messages: [{ role: "user" as const, content: "q" }], temperature: 1.0, stream: false },
          { ...hit, temperature: 1.0, maxTokens: undefined },
          { provider: "mock", threshold },
        );
        if (d.reusable) { reused = true; break; }
      }
      if (reused && f.mustHit) tp++;
      else if (reused && !f.mustHit) fp++;
      else if (!reused && f.mustHit) fn++;
      else tn++;
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    out.push({ threshold, tp, fp, fn, tn, precision, recall });
  }
  return out;
}

describe("threshold sweep (real store + real policy, labeled synthetic set)", () => {
  it(`dataset ${DATASET_VERSION} is labeled with minimum family counts`, () => {
    for (const family of ["paraphrase", "near-miss", "topical", "unrelated"] as const) {
      expect(FIXTURES.filter((f) => f.family === family).length).toBeGreaterThanOrEqual(3);
    }
    expect(FIXTURES.every((f) => f.name && typeof f.mustHit === "boolean")).toBe(true);
  });

  it("sweep 0.60->0.95 is deterministic across runs (seeded, no I/O)", async () => {
    const thresholds = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95];
    const run = async () => {
      const store = new InMemoryVectorStore();
      await seed(store);
      return sweep(store, thresholds);
    };
    expect(await run()).toEqual(await run());
  });

  it("0.92 keeps FP at zero with full recall; 0.90 lets the 0.91 near-miss through", async () => {
    const store = new InMemoryVectorStore();
    await seed(store);
    const points = await sweep(store, [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95]);
    console.log(`\n[threshold sweep ${DATASET_VERSION}] thr | TP FP FN TN | precision recall`);
    for (const p of points) {
      console.log(`  ${p.threshold.toFixed(2)} | ${p.tp}  ${p.fp}  ${p.fn}  ${p.tn} | ${p.precision.toFixed(3)}   ${p.recall.toFixed(3)}`);
    }
    // Cost-aware optimum (stated assumption): a false-positive reuse costs far
    // more than a missed save (wrong answer >> extra provider call), so the
    // optimum is the highest recall with FP == 0 -> 0.92 on this set.
    const at92 = points.find((p) => p.threshold === 0.92)!;
    expect(at92.fp).toBe(0);
    expect(at92.recall).toBe(1);
    expect(at92.precision).toBe(1);
    const at90 = points.find((p) => p.threshold === 0.9)!;
    expect(at90.fp).toBeGreaterThanOrEqual(1);
  });
});

describe("exact-cache latency numbers (HIT vs MISS, mock delayMs=50)", () => {
  it("HIT p95 stays far below MISS median; avoided calls accounted", async () => {
    const app: FastifyInstance = Fastify();
    const provider = new MockProvider({ delayMs: 50 });
    registerChatRoutes(app, provider, cfg(), new InMemoryCache());
    const prompt = "eval numbers latency probe";
    const body = { model: "m", messages: [{ role: "user", content: prompt }] };
    const missLat: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { ...body, messages: [{ role: "user", content: `${prompt} ${i}` }] } });
      expect(r.statusCode).toBe(200);
      missLat.push(Date.now() - t0);
    }
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    const hitLat: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const r = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
      expect(r.headers["x-cache"]).toBe("HIT");
      hitLat.push(Date.now() - t0);
    }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.ceil(0.95 * a.length) - 1];
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`\n[exact latency] HIT n=20 avg=${avg(hitLat).toFixed(1)}ms p95=${p95(hitLat)}ms | MISS n=5 avg=${avg(missLat).toFixed(1)}ms med=${med(missLat)}ms`);
    const snap = await app.inject({ method: "GET", url: "/metrics" });
    console.log(`[avoided] provider_calls_avoided=${snap.json().provider_calls_avoided} (20 HITs + 0 coalesced)`);
    expect(p95(hitLat)).toBeLessThan(med(missLat));
    expect(snap.json().provider_calls_avoided).toBeGreaterThanOrEqual(20);
    await app.close();
  });
});

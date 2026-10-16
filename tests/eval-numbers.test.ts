// tests/eval-numbers.test.ts — offline eval numbers (threshold sweep + exact latency).
// The sweep itself lives in scripts/eval/* (the T15 harness); this file pins its
// dataset contract, determinism, boundary numbers, and cost-aware optimum.

import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { InMemoryCache } from "../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../src/cache/InMemoryVectorStore.js";
import type { GatewayConfig } from "../src/infrastructure/config.js";
import { registerChatRoutes } from "../src/api/routes/chat.js";
import { MockProvider } from "../src/providers/MockProvider.js";
import { laneAuth } from "./helpers/lane.js";
import { DATASET_VERSION, FAMILIES, MIN_PER_FAMILY, validateDataset } from "../scripts/eval/dataset.js";
import {
  DEFAULT_COST_ASSUMPTION,
  THRESHOLDS,
  buildReport,
  chooseOptimum,
  netUsd,
  seedStore,
  sweep,
} from "../scripts/eval/harness.js";

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
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "", savedUsdPer1kTokens: 0,
    ...over,
  };
}

async function runSweep() {
  const store = new InMemoryVectorStore();
  await seedStore(store);
  return sweep(store, THRESHOLDS);
}

describe("threshold sweep (real store + real policy, labeled synthetic set)", () => {
  it(`dataset ${DATASET_VERSION} is labeled + versioned with minimum family counts`, () => {
    const v = validateDataset();
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    for (const family of FAMILIES) {
      expect(v.counts[family], `family ${family}`).toBeGreaterThanOrEqual(MIN_PER_FAMILY);
    }
  });

  it("sweep 0.60->0.95 is deterministic across runs (no randomness, no I/O)", async () => {
    expect(await runSweep()).toEqual(await runSweep());
  });

  it("0.92 keeps FP at zero with full recall; 0.90 lets the 0.91 near-miss through", async () => {
    const points = await runSweep();
    console.log(`\n[threshold sweep ${DATASET_VERSION}] thr | TP FP FN TN | precision recall | net $`);
    for (const p of points) {
      console.log(
        `  ${p.threshold.toFixed(2)} | ${p.tp}  ${p.fp}  ${p.fn}  ${p.tn} | ${p.precision.toFixed(3)}   ${p.recall.toFixed(3)} | ${netUsd(p).toFixed(4)}`,
      );
    }
    const at92 = points.find((p) => p.threshold === 0.92)!;
    expect(at92.fp).toBe(0);
    expect(at92.recall).toBe(1);
    expect(at92.precision).toBe(1);
    expect(at92.safeReuseRate).toBe(1);
    expect(at92.pChr).toBe(1);
    for (const [fam, r] of Object.entries(at92.perFamily)) {
      expect(r.fp, `family ${fam}`).toBe(0);
    }
    expect(at92.perFamily["duplicate"]!.tp).toBe(3);
    expect(at92.perFamily["paraphrase"]!.tp).toBe(4);
    const at90 = points.find((p) => p.threshold === 0.9)!;
    expect(at90.fp).toBeGreaterThanOrEqual(1);
    expect(at90.perFamily["near-miss"]!.fp).toBeGreaterThanOrEqual(1);
  });

  it("cost-aware optimum is 0.92 under the stated FP-penalty x price assumption", async () => {
    const points = await runSweep();
    const opt = chooseOptimum(points, DEFAULT_COST_ASSUMPTION);
    expect(opt.threshold).toBe(0.92);
    expect(netUsd(opt, DEFAULT_COST_ASSUMPTION)).toBeGreaterThan(0);
    // One step lower serves a wrong answer (the 0.91 near-miss) and goes
    // net-negative: the FP penalty dominates the call price, so 0.92 wins.
    const at90 = points.find((p) => p.threshold === 0.9)!;
    expect(netUsd(at90, DEFAULT_COST_ASSUMPTION)).toBeLessThan(0);
  });

  it("report output is byte-identical across runs (no timestamps, no randomness)", async () => {
    expect(buildReport(await runSweep())).toBe(buildReport(await runSweep()));
  });
});

describe("exact-cache latency numbers (HIT vs MISS, mock delayMs=50)", () => {
  it("HIT p95 stays far below MISS median; avoided calls accounted", async () => {
    const app: FastifyInstance = Fastify();
    const provider = new MockProvider({ delayMs: 50 });
    // T26: registered lane so the exact-cache pipeline runs (string "mock").
    const lane = await laneAuth("mock");
    const laneHeaders = lane.headersFor("mock");
    registerChatRoutes(app, provider, cfg(), new InMemoryCache(), { auth: lane.auth });
    const prompt = "eval numbers latency probe";
    const body = { model: "m", messages: [{ role: "user", content: prompt }] };
    const missLat: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: laneHeaders, payload: { ...body, messages: [{ role: "user", content: `${prompt} ${i}` }] } });
      expect(r.statusCode).toBe(200);
      missLat.push(Date.now() - t0);
    }
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: laneHeaders, payload: body });
    const hitLat: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const r = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: laneHeaders, payload: body });
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

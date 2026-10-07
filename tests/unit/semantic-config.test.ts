import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";
import { createSemanticStoreFromEnv } from "../../src/cache/semanticFactory.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { GatewayMetrics } from "../../src/observability/metrics.js";

function env(over: Record<string, string | undefined> = {}) {
  return {
    PROVIDER: "mock",
    EMBEDDING_PROVIDER: "mock",
    SEMANTIC_STORE: "memory",
    ...over,
  } as NodeJS.ProcessEnv;
}

describe("semantic config + factory", () => {
  it("parses semantic env with safe fallbacks", () => {
    const c = loadConfig(env({ SEMANTIC_ENABLED: "0", SEMANTIC_THRESHOLD: "0.8", SEMANTIC_TOP_K: "5", SEMANTIC_TTL_S: "60" }));
    expect(c.semanticEnabled).toBe(false);
    expect(c.semanticThreshold).toBeCloseTo(0.8);
    expect(c.semanticTopK).toBe(5);
    expect(c.semanticTtlSec).toBe(60);
  });

  it("rejects out-of-range threshold (must be a fraction)", () => {
    expect(loadConfig(env({ SEMANTIC_THRESHOLD: "1.5" })).semanticThreshold).toBeCloseTo(0.92);
    expect(loadConfig(env({ SEMANTIC_THRESHOLD: "abc" })).semanticThreshold).toBeCloseTo(0.92);
  });

  it("rejects unknown SEMANTIC_STORE", () => {
    expect(() => loadConfig(env({ SEMANTIC_STORE: "redis" }))).toThrow(/SEMANTIC_STORE/);
  });

  it("openrouter: PROVIDER accepted, defaults are OpenAI-wire + a verified :free model", () => {
    const c = loadConfig(env({ PROVIDER: "openrouter" }));
    expect(c.provider).toBe("openrouter");
    expect(c.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(c.openRouterModel).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(c.openRouterKey).toBe("");
  });

  it("openrouter key env var is OPEN_ROUTER_KEY (project .env convention)", () => {
    expect(loadConfig(env({ PROVIDER: "openrouter", OPEN_ROUTER_KEY: "sk-or-test" })).openRouterKey).toBe("sk-or-test");
  });

  it("disabled semantic returns undefined (no store)", async () => {
    const c = loadConfig(env({ SEMANTIC_ENABLED: "0" }));
    await expect(createSemanticStoreFromEnv(c)).resolves.toBeUndefined();
  });

  it("memory store is the zero-setup default", async () => {
    const c = loadConfig(env({}));
    const s = await createSemanticStoreFromEnv(c);
    expect(s).toBeInstanceOf(InMemoryVectorStore);
    await s!.close();
  });

  it("pgvector without DATABASE_URL fails fast and loud", async () => {
    const c = loadConfig(env({ SEMANTIC_STORE: "pgvector", DATABASE_URL: "" }));
    await expect(createSemanticStoreFromEnv(c)).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("GatewayMetrics semantic counters", () => {
  it("tracks semantic hit/miss lookups + avg score", () => {
    const m = new GatewayMetrics();
    m.inc("semantic_hits");
    m.inc("semantic_misses", 3);
    m.observeSemanticScore(0.95);
    m.observeSemanticScore(0.85);
    const s = m.snapshot();
    expect(s.semantic_lookups).toBe(4);
    expect(s.avg_semantic_score).toBeCloseTo(0.9);
    expect(s.semantic_hits).toBe(1);
    expect(s.semantic_errors).toBe(0);
  });

  it("zero semantic traffic averages to 0 and resets cleanly", () => {
    const m = new GatewayMetrics();
    expect(m.snapshot().avg_semantic_score).toBe(0);
    m.inc("semantic_errors");
    m.reset();
    const s = m.snapshot();
    expect(s.semantic_errors).toBe(0);
    expect(s.semantic_lookups).toBe(0);
  });
});

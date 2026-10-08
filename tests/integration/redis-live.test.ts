// tests/integration/redis-live.test.ts — exact cache over real Redis (opt-in REDIS_LIVE_TEST=1).

import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { RedisCache } from "../../src/cache/RedisCache.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

const LIVE = process.env.REDIS_LIVE_TEST === "1";

function cfg(): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "eval/model:free",
    redisUrl: process.env.REDIS_URL ?? "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: false, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "",
  };
}

describe.skipIf(!LIVE)("exact cache over live Redis (opt-in: REDIS_LIVE_TEST=1)", () => {
  const cache = new RedisCache({ url: process.env.REDIS_URL ?? "" });

  afterAll(async () => {
    await cache.close();
  });

  it("redis pings healthy", async () => {
    await expect(cache.ping()).resolves.toBe(true);
  });

  it("seed -> HIT round trip through Redis, provider runs once", async () => {
    metrics.reset();
    const app = Fastify();
    let calls = 0;
    const provider = new MockProvider();
    const orig = provider.chat.bind(provider);
    provider.chat = (async (...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
    registerChatRoutes(app, provider, cfg(), cache);
    const prompt = `eval redis-live roundtrip ${Date.now()}`;
    const body = { model: "m", messages: [{ role: "user", content: prompt }] };
    const seed = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(seed.statusCode).toBe(200);
    expect(seed.headers["x-cache"]).toBe("MISS");
    const hit = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.json().choices[0].message.content).toBe(seed.json().choices[0].message.content);
    expect(calls).toBe(1);
    await app.close();
  });

  it("different prompt is a MISS (no cross-key bleed in Redis)", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg(), cache);
    const miss = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: `eval redis-live other ${Date.now()}` }] },
    });
    expect(miss.headers["x-cache"]).toBe("MISS");
    await app.close();
  });
});

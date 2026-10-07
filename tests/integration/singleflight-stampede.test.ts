import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { GatewayError } from "../../src/domain/types.js";
import type { ChatResponse } from "../../src/domain/types.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 5000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: false, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "",
    ...over,
  };
}

const body = { model: "m", messages: [{ role: "user", content: "stampede" }] };

beforeEach(() => metrics.reset());

describe("single-flight stampede (Day 11 integration)", () => {
  it("50 concurrent identical misses => 1 provider call, all 200", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    let calls = 0;
    const provider = new MockProvider({ delayMs: 150 });
    const orig = provider.chat.bind(provider);
    provider.chat = (async (...a: Parameters<typeof orig>) => {
      calls++;
      return orig(...a);
    }) as typeof orig;
    registerChatRoutes(app, provider, cfg(), cache);

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        app.inject({ method: "POST", url: "/v1/chat/completions", payload: body }),
      ),
    );
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(["MISS", "HIT"]).toContain(r.headers["x-cache"]);
    }
    expect(calls).toBe(1);
    const coalesced = results.filter((r) => r.headers["x-coalesced"] === "true").length;
    expect(coalesced).toBeGreaterThanOrEqual(40); // timing slack: most must coalesce
    const snap = (await app.inject({ method: "GET", url: "/metrics" })).json();
    expect(snap.singleflight_coalesced).toBeGreaterThanOrEqual(40);
    expect(snap.provider_requests).toBe(1);
    await app.close();
  });

  it("different prompts do NOT coalesce", async () => {
    const app = Fastify();
    let calls = 0;
    const provider = new MockProvider({ delayMs: 80 });
    const orig = provider.chat.bind(provider);
    provider.chat = (async (...a: Parameters<typeof orig>) => {
      calls++;
      return orig(...a);
    }) as typeof orig;
    registerChatRoutes(app, provider, cfg(), new InMemoryCache());
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/chat/completions", payload: body }),
      app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "m", messages: [{ role: "user", content: "different" }] },
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(calls).toBe(2);
    await app.close();
  });

  it("provider failure reaches all waiters but does not poison the next retry", async () => {
    const app = Fastify();
    let calls = 0;
    let shouldFail = true;
    const flaky: ProviderAdapter = {
      name: "mock",
      capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true },
      async chat(req, _signal): Promise<ChatResponse> {
        calls++;
        await new Promise<void>((r) => setTimeout(r, 50));
        if (shouldFail) throw new GatewayError(502, "provider_error", "flaky", true);
        return { id: "ok", model: req.model, content: "recovered" };
      },
      async *chatStream() {
        yield { delta: "x" };
      },
    };
    registerChatRoutes(app, flaky, cfg(), new InMemoryCache());
    const failed = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: "POST", url: "/v1/chat/completions", payload: body }),
      ),
    );
    for (const r of failed) expect(r.statusCode).toBe(502);
    expect(calls).toBe(1); // one leader execution shared by 5 waiters
    shouldFail = false;
    const retry = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(retry.statusCode).toBe(200);
    expect(calls).toBe(2);
    await app.close();
  });
});

describe("cache metrics endpoint (Day 13 integration)", () => {
  it("HIT/MISS update /metrics with hit_rate + avoided", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache());
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body }); // MISS
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body }); // HIT
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.requests_total).toBe(2);
    expect(s.exact_hits).toBe(1);
    expect(s.exact_misses).toBe(1);
    expect(s.hit_rate).toBeCloseTo(0.5);
    expect(s.provider_requests).toBe(1);
    expect(s.provider_calls_avoided).toBe(1);
    expect(s.avg_cache_lookup_ms).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});

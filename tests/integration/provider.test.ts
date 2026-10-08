import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import { createProviderFromEnv } from "../../src/providers/factory.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 100,
    geminiApiKey: "", geminiModel: "gemini-2.0-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: false, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "", savedUsdPer1kTokens: 0,
    ...over,
  };
}

describe("provider failure normalization", () => {
  it("slow provider -> 504 gateway_timeout (no hang)", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider({ delayMs: 5000 }), cfg({ upstreamTimeoutMs: 100 }));
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe("gateway_timeout");
  });

  it("rate_limited mock -> 429, server_error mock -> 502", async () => {
    for (const [failure, status] of [["rate_limited", 429], ["server_error", 502]] as const) {
      const app = Fastify();
      registerChatRoutes(app, new MockProvider({ failure }), cfg({ upstreamTimeoutMs: 2000 }));
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(status);
    }
  });

  it("tight timeout bounds retries: error promptly, never hangs", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider({ failure: "rate_limited" }), cfg({ upstreamTimeoutMs: 100 }));
    const t0 = Date.now();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    const elapsed = Date.now() - t0;
    expect([429, 504]).toContain(res.statusCode);
    expect(elapsed).toBeLessThan(2000);
  });

  it("factory chooses provider from env (CHOOSING pattern)", () => {
    expect(createProviderFromEnv(cfg({ provider: "mock" })).name).toBe("mock");
    expect(createProviderFromEnv(cfg({ provider: "ollama" })).name).toBe("ollama");
    expect(() => createProviderFromEnv(cfg({ provider: "gemini" }))).toThrow("GEMINI_API_KEY");
    expect(createProviderFromEnv(cfg({ provider: "gemini", geminiApiKey: "k" })).name).toBe("gemini");
  });

  it("aborted signal rejects instead of hanging", async () => {
    const p = new MockProvider({ delayMs: 5000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 1, stream: false }, ctrl.signal)).rejects.toMatchObject({ status: 504 });
  });
});

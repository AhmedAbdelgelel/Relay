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
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
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
      registerChatRoutes(app, new MockProvider({ failure }), cfg());
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(status);
    }
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

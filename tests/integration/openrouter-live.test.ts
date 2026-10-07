import "dotenv/config";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";

// Live-OpenRouter tests against FREE models ($0 spend). Skipped entirely
// without OPEN_ROUTER_KEY, so CI and every offline run stay offline
// (`GEMINI_API_KEY= npm test` runs these only if OPEN_ROUTER_KEY is set).
// Free-tier limits: 20 requests/min, 50/day below $10 lifetime credit —
// the suite makes 3 requests per run (non-stream, stream, gateway roundtrip).
const HAS_KEY = !!process.env.OPEN_ROUTER_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-super-120b-a12b:free";
const BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

function liveProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: "openrouter",
    baseURL: BASE_URL,
    apiKey: process.env.OPEN_ROUTER_KEY ?? "",
    defaultModel: MODEL,
  });
}

function liveCfg(): GatewayConfig {
  return {
    port: 3000,
    provider: "openrouter",
    upstreamTimeoutMs: 60000,
    geminiApiKey: "",
    geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1",
    ollamaModel: "llama3.1:8b",
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "",
    anthropicBaseUrl: "https://api.anthropic.com",
    anthropicModel: "claude-4",
    openRouterKey: process.env.OPEN_ROUTER_KEY ?? "",
    openRouterBaseUrl: BASE_URL,
    openRouterModel: MODEL,
    redisUrl: "",
    cacheTtlSec: 3600,
    cacheEnabled: true,
    embeddingProvider: "mock",
    embeddingModel: "",
    semanticEnabled: false,
    semanticThreshold: 0.92,
    semanticTopK: 3,
    semanticTtlSec: 3600,
    semanticStore: "memory",
    databaseUrl: "",
  };
}

describe.skipIf(!HAS_KEY)("openrouter live free-model eval (real upstream, $0 tier)", () => {
  it(
    "chat() on a :free model returns non-empty OpenAI-shaped content + usage",
    async () => {
      const provider = liveProvider();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        const out = await provider.chat(
          {
            model: MODEL,
            messages: [{ role: "user", content: "Reply with exactly: OPENROUTER_OK" }],
            temperature: 0,
            stream: false,
          },
          ctrl.signal,
        );
        expect(out.id).toBeTruthy();
        expect(out.model).toContain(":free");
        expect(out.content.toLowerCase()).toContain("openrouter_ok");
        // Usage is reported by OpenRouter; preserved-or-absent, never invented.
        if (out.usage) {
          expect(out.usage.prompt_tokens).toBeGreaterThanOrEqual(0);
          expect(out.usage.completion_tokens).toBeGreaterThanOrEqual(0);
        }
      } finally {
        clearTimeout(timer);
      }
    },
    60000,
  );

  it(
    "chatStream() on a :free model yields deltas that join to text",
    async () => {
      const provider = liveProvider();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        let acc = "";
        for await (const chunk of provider.chatStream(
          {
            model: MODEL,
            messages: [{ role: "user", content: "Count to 3, digits only." }],
            temperature: 0,
            stream: true,
          },
          ctrl.signal,
        )) {
          expect(typeof chunk.delta).toBe("string");
          acc += chunk.delta;
        }
        expect(acc.length).toBeGreaterThan(0);
        expect(acc).toMatch(/1|2|3/);
      } finally {
        clearTimeout(timer);
      }
    },
    60000,
  );

  it(
    "gateway POST /v1/chat/completions with a :free model returns OpenAI shape + evidence headers",
    async () => {
      const cfg = liveCfg();
      const app = Fastify();
      registerChatRoutes(app, liveProvider(), cfg);
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: MODEL,
          messages: [{ role: "user", content: "Reply with exactly: GATEWAY_OR_OK" }],
          temperature: 0,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toBeTruthy();
      expect(res.headers["x-provider"]).toBe("openrouter");
      expect(String(res.headers["x-cache-hash"])).toMatch(/^[0-9a-f]{64}$/);
      const json = res.json();
      expect(json.choices[0].message.role).toBe("assistant");
      expect(json.choices[0].message.content.toLowerCase()).toContain("gateway_or_ok");
      await app.close();
    },
    60000,
  );
});

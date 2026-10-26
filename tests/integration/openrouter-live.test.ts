import "dotenv/config";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import { laneAuth } from "../helpers/lane.js";

// Live OpenRouter tests — the default live leg (Gemini remains a manual
// opt-in). They call the real endpoint on the free tier, so they must never
// run in the default `npm test` sweep, which stays hermetic, offline and
// free: two-factor opt-in, the file skips itself unless OPENROUTER_LIVE_TEST=1
// AND OPEN_ROUTER_KEY are both present (a key sitting in .env alone is not
// enough). Exactly 3 upstream calls per run, all on `:free` models ($0 tier).
// Run with: npm run test:live  (or: OPENROUTER_LIVE_TEST=1 npm test).
// Free models still need a free OpenRouter account key — there is no
// anonymous API access. Override the model with OPENROUTER_MODEL (must end
// with ":free" to stay on the $0 tier).
const LIVE = process.env.OPENROUTER_LIVE_TEST === "1";
const HAS_KEY = !!process.env.OPEN_ROUTER_KEY;
// A small free instruct model keeps the smoke fast and compliant; override
// with OPENROUTER_MODEL for a bigger :free model. Free ids churn: this one was
// verified against the live $0 tier (2026-10-26).
const MODEL = process.env.OPENROUTER_MODEL || "cohere/north-mini-code:free";
const BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const LIVE_TIMEOUT_MS = 60000;

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
    upstreamTimeoutMs: LIVE_TIMEOUT_MS,
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
    savedUsdPer1kTokens: 0,
    gatewayApiKeys: [],
    credEncKey: "",
  };
}

describe.skipIf(!LIVE || !HAS_KEY)("openrouter live prompt (free-tier upstream)", () => {
  it(
    "chat() prompt returns non-empty content + usage",
    async () => {
      const provider = liveProvider();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LIVE_TIMEOUT_MS);
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
        expect(out.model).toBeTruthy();
        expect(out.content).toContain("OPENROUTER_OK");
        // OpenRouter always returns usage for non-streaming completions.
        expect(out.usage?.prompt_tokens).toBeGreaterThan(0);
      } finally {
        clearTimeout(timer);
      }
    },
    65000,
  );

  it(
    "chatStream() prompt yields chunks that join to text",
    async () => {
      const provider = liveProvider();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LIVE_TIMEOUT_MS);
      try {
        let acc = "";
        for await (const chunk of provider.chatStream(
          {
            model: MODEL,
            messages: [{ role: "user", content: "Count from 1 to 3, digits only." }],
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
    65000,
  );

  it(
    "gateway POST /v1/chat/completions via openrouter returns OpenAI shape",
    async () => {
      const cfg = liveCfg();
      const app = Fastify();
      // T26: registered lane; the live upstream key still comes from env
      // (no stored credential), so the gateway's env key serves the request.
      const lane = await laneAuth("openrouter");
      registerChatRoutes(app, liveProvider(), cfg, undefined, { auth: lane.auth });
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: lane.headersFor("openrouter"),
        payload: {
          model: MODEL,
          messages: [{ role: "user", content: "Reply with exactly: GATEWAY_OK" }],
          temperature: 0,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toBeTruthy();
      expect(res.headers["x-provider"]).toBe("openrouter");
      expect(res.headers["x-lane"]).toBe("registered");
      const json = res.json();
      expect(json.choices[0].message.role).toBe("assistant");
      expect(json.choices[0].message.content).toContain("GATEWAY_OK");
      await app.close();
    },
    65000,
  );
});

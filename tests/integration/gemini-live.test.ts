import "dotenv/config";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";

// Live-Gemini prompt tests. Skipped without a key so CI stays green on mock only.
// Run with: npm test (picks these up automatically when .env has GEMINI_API_KEY).
// These hit the real Gemini OpenAI-compat endpoint — non-stream, stream, and
// the full gateway HTTP path (validation + headers + OpenAI response shape).
const HAS_KEY = !!process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const BASE_URL =
  process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";

function liveProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: "gemini",
    baseURL: BASE_URL,
    apiKey: process.env.GEMINI_API_KEY ?? "",
    defaultModel: MODEL,
  });
}

function liveCfg(): GatewayConfig {
  return {
    port: 3000,
    provider: "gemini",
    upstreamTimeoutMs: 25000,
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: MODEL,
    geminiBaseUrl: BASE_URL,
    ollamaBaseUrl: "http://localhost:11434/v1",
    ollamaModel: "llama3.1:8b",
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    redisUrl: "",
    cacheTtlSec: 3600,
    cacheEnabled: true,
  };
}

describe.skipIf(!HAS_KEY)("gemini live prompt (real upstream)", () => {
  it(
    "chat() prompt returns non-empty content + usage",
    async () => {
      const provider = liveProvider();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const out = await provider.chat(
          {
            model: MODEL,
            messages: [{ role: "user", content: "Reply with exactly: GEMINI_OK" }],
            temperature: 0,
            stream: false,
          },
          ctrl.signal,
        );
        expect(out.id).toBeTruthy();
        expect(out.model).toContain("gemini");
        expect(out.content).toContain("GEMINI_OK");
        expect(out.usage?.prompt_tokens).toBeGreaterThan(0);
      } finally {
        clearTimeout(timer);
      }
    },
    30000,
  );

  it(
    "chatStream() prompt yields chunks that join to text",
    async () => {
      const provider = liveProvider();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
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
    30000,
  );

  it(
    "gateway POST /v1/chat/completions with gemini returns OpenAI shape",
    async () => {
      const cfg = liveCfg();
      const app = Fastify();
      registerChatRoutes(app, liveProvider(), cfg);
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: MODEL,
          messages: [{ role: "user", content: "Reply with exactly: GATEWAY_OK" }],
          temperature: 0,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toBeTruthy();
      expect(res.headers["x-provider"]).toBe("gemini");
      const json = res.json();
      expect(json.choices[0].message.role).toBe("assistant");
      expect(json.choices[0].message.content).toContain("GATEWAY_OK");
      await app.close();
    },
    30000,
  );
});

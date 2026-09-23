import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { buildExactCacheKey } from "../../src/domain/normalize.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";

function testApp(provider: ProviderAdapter = new MockProvider()) {
  const app = Fastify();
  const cfg: GatewayConfig = {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-2.0-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
  };
  registerChatRoutes(app, provider, cfg);
  return app;
}

describe("POST /v1/chat/completions contract", () => {
  it("happy path returns OpenAI shape + x-request-id", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
    const json = res.json();
    expect(json.choices[0].message.content).toContain("mock echo");
  });

  it("invalid body -> 400 and never calls provider", async () => {
    let called = false;
    const spy = new MockProvider();
    const orig = spy.chat.bind(spy);
    spy.chat = (async (...a: Parameters<typeof orig>) => { called = true; return orig(...a); }) as typeof orig;
    const app = testApp(spy);
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "", messages: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(called).toBe(false);
  });

  it("stream:true returns SSE with [DONE]", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("data: [DONE]");
  });
});

// D1/D2/D3 invariants from DECISIONS.md — these are the metrics contract the
// browser playground reads. If one of them fails, the metrics section lies.
type ReqBody = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
};

describe("metrics contract (cache hash, stream usage, TTFT, pre-stream errors)", () => {
  const hashOf = (payload: ReqBody) =>
    buildExactCacheKey("mock", {
      model: payload.model,
      messages: payload.messages,
      temperature: payload.temperature ?? 1.0,
      max_tokens: payload.max_tokens,
      stream: payload.stream ?? false,
    }).hash;

  it("x-cache-hash equals the canonical sha256 on a non-stream 200", async () => {
    const app = testApp();
    const payload: ReqBody = { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hash me" }], temperature: 0.3 };
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache-hash"]).toBe(hashOf(payload));
    expect(String(res.headers["x-cache-hash"])).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("stream:true reports BYPASS + the would-be hash + x-latency-ms (TTFT)", async () => {
    const app = testApp();
    const payload: ReqBody = { model: "gemini-2.0-flash", messages: [{ role: "user", content: "stream hash" }], stream: true };
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-cache-hash"]).toBe(hashOf(payload));
    expect(Number(res.headers["x-latency-ms"])).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it("400 invalid_request never gets a hash (validation runs first)", async () => {
    const app = testApp();
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "", messages: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.headers["x-cache-hash"]).toBeUndefined();
    await app.close();
  });

  it("stream body carries a usage frame before [DONE] (D1)", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "gemini-2.0-flash", messages: [{ role: "user", content: "usage please" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    const frames = res.body
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6));
    const doneAt = frames.indexOf("[DONE]");
    expect(doneAt).toBeGreaterThan(0);
    const parsed = frames.slice(0, doneAt).map((f) => JSON.parse(f));
    const usageFrame = parsed.find((f) => f.usage !== undefined);
    expect(usageFrame).toBeTruthy();
    expect(usageFrame.choices).toEqual([]); // OpenAI terminal-usage frame shape
    expect(usageFrame.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(parsed.some((f) => f.choices?.[0]?.delta?.content)).toBe(true);
    await app.close();
  });

  it("provider failing BEFORE the first token returns real JSON status, not an empty 200 (D2)", async () => {
    const app = testApp(new MockProvider({ failure: "rate_limited" }));
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error.code).toBe("provider_rate_limited");
    expect(res.body).not.toContain("data:");
    expect(res.headers["x-cache-hash"]).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("upstream timeout before the first token is 504 JSON (D2)", async () => {
    const shortCfg: GatewayConfig = {
      port: 3000, provider: "mock", upstreamTimeoutMs: 50,
      geminiApiKey: "", geminiModel: "gemini-2.0-flash",
      geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
      openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
      redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    };
    const app = Fastify();
    registerChatRoutes(app, new MockProvider({ delayMs: 5000 }), shortCfg);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe("gateway_timeout");
    await app.close();
  });

  it("provider that yields nothing still closes the stream with [DONE] (D2)", async () => {
    const empty: ProviderAdapter = {
      name: "empty",
      chat: async () => {
        throw new Error("not used in this test");
      },
      chatStream: async function* () {
        /* no chunks at all */
      },
    };
    const app = testApp(empty);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("data: [DONE]");
    expect(res.body).not.toContain('"usage"'); // never invent usage
    expect(res.headers["x-cache-hash"]).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });
});

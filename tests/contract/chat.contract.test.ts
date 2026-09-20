import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

function testApp(provider = new MockProvider()) {
  const app = Fastify();
  const cfg: GatewayConfig = {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-2.0-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
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

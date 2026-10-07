import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { buildProviderStatus, registerProviderRoutes } from "../../src/api/routes/providers.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { AnthropicAdapter } from "../../src/providers/AnthropicAdapter.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { ProviderAdapter, StreamChunk } from "../../src/providers/ProviderAdapter.js";
import { createProvidersFromEnv, providerForModel } from "../../src/providers/factory.js";
import type { ChatRequest, ChatResponse } from "../../src/domain/types.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com",
    anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: false, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "",
    ...over,
  };
}

function stub(name: string, counter: { calls: number }): ProviderAdapter {
  return {
    name,
    capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true },
    async chat(req: ChatRequest, _signal: AbortSignal): Promise<ChatResponse> {
      counter.calls++;
      return {
        id: `${name}-1`,
        model: req.model,
        content: `${name} reply`,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    },
    async *chatStream(req: ChatRequest, _signal: AbortSignal): AsyncIterable<StreamChunk> {
      counter.calls++;
      yield { delta: `${name} ` };
      void req;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerForModel routing", () => {
  it("routes by model prefix, else fallback", () => {
    const openai = stub("openai", { calls: 0 });
    const anthropic = stub("anthropic", { calls: 0 });
    const gemini = stub("gemini", { calls: 0 });
    const ollama = stub("ollama", { calls: 0 });
    const openrouter = stub("openrouter", { calls: 0 });
    const fallback = stub("mock", { calls: 0 });
    const map = new Map<string, ProviderAdapter>([
      ["openai", openai],
      ["anthropic", anthropic],
      ["gemini", gemini],
      ["ollama", ollama],
      ["openrouter", openrouter],
      ["mock", fallback],
    ]);
    expect(providerForModel("gpt-4o-mini", map, fallback)).toBe(openai);
    expect(providerForModel("GPT-5", map, fallback)).toBe(openai);
    expect(providerForModel("claude-4", map, fallback)).toBe(anthropic);
    expect(providerForModel("gemini-3.6-flash", map, fallback)).toBe(gemini);
    expect(providerForModel("llama3.1:8b", map, fallback)).toBe(ollama);
    expect(providerForModel("nomic-embed", map, fallback)).toBe(ollama);
    expect(providerForModel("unknown-model", map, fallback)).toBe(fallback);
  });

  it("routes OpenRouter free-variant and vendor-prefixed models to openrouter", () => {
    const openrouter = stub("openrouter", { calls: 0 });
    const fallback = stub("mock", { calls: 0 });
    const map = new Map<string, ProviderAdapter>([
      ["openrouter", openrouter],
      ["mock", fallback],
    ]);
    // Verified OpenRouter free IDs (vendor/model:free) and the auto router.
    expect(providerForModel("qwen/qwen3.8-27b:free", map, fallback)).toBe(openrouter);
    expect(providerForModel("nvidia/nemotron-3-super-120b-a12b:free", map, fallback)).toBe(openrouter);
    expect(providerForModel("google/gemma-4-31b-it:free", map, fallback)).toBe(openrouter);
    expect(providerForModel("openrouter/auto", map, fallback)).toBe(openrouter);
    // Non-free, non-prefixed ids still fall back.
    expect(providerForModel("some-model", map, fallback)).toBe(fallback);
  });

  it("explicit earlier prefixes win over the :free signal (documented precedence)", () => {
    const openai = stub("openai", { calls: 0 });
    const openrouter = stub("openrouter", { calls: 0 });
    const fallback = stub("mock", { calls: 0 });
    const map = new Map<string, ProviderAdapter>([
      ["openai", openai],
      ["openrouter", openrouter],
      ["mock", fallback],
    ]);
    expect(providerForModel("gpt-4o-mini", map, fallback)).toBe(openai);
    expect(providerForModel("gpt-4o-mini:free", map, fallback)).toBe(openai);
  });

  it("falls back when the routed provider is not configured", () => {
    const fallback = stub("mock", { calls: 0 });
    const map = new Map<string, ProviderAdapter>([["mock", fallback]]);
    expect(providerForModel("gpt-4o-mini", map, fallback)).toBe(fallback);
    expect(providerForModel("claude-4", map, fallback)).toBe(fallback);
  });
});

describe("createProvidersFromEnv", () => {
  it("always has mock+ollama+openrouter; keyed providers only when key present", () => {
    const empty = createProvidersFromEnv(cfg());
    expect(empty.has("mock")).toBe(true);
    expect(empty.has("ollama")).toBe(true);
    expect(empty.has("openrouter")).toBe(true); // free tier needs no key
    expect(empty.has("gemini")).toBe(false);
    expect(empty.has("openai")).toBe(false);
    expect(empty.has("anthropic")).toBe(false);

    const full = createProvidersFromEnv(cfg({ geminiApiKey: "g", openaiApiKey: "o", anthropicApiKey: "a", openRouterKey: "or" }));
    expect(full.get("gemini")?.name).toBe("gemini");
    expect(full.get("openai")?.name).toBe("openai");
    expect(full.get("anthropic")?.name).toBe("anthropic");
    expect(full.get("openrouter")?.name).toBe("openrouter");
  });
});

describe("GET /providers", () => {
  it("hides keys and flags configured correctly", async () => {
    const app = Fastify();
    const c = cfg({ provider: "gemini", geminiApiKey: "secret-gemini", openaiApiKey: "", anthropicApiKey: "secret-a" });
    const providers = createProvidersFromEnv(c);
    registerProviderRoutes(app, c, providers);
    const res = await app.inject({ method: "GET", url: "/providers" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret-gemini");
    expect(raw).not.toContain("secret-a");
    expect(raw).not.toContain("API_KEY");
    const byId = Object.fromEntries(body.map((p: { id: string }) => [p.id, p]));
    expect(byId["gemini"].configured).toBe(true);
    expect(byId["anthropic"].configured).toBe(true);
    expect(byId["openai"].configured).toBe(false);
    expect(byId["ollama"].configured).toBe(true);
    expect(byId["mock"].configured).toBe(true);
    expect(byId["gemini"].active).toBe(true);
    expect(byId["openai"].active).toBe(false);
    expect(byId["gemini"].label).toBe("Google");
    expect(byId["openai"].label).toBe("OpenAI");
    expect(byId["anthropic"].label).toBe("Anthropic");
    expect(byId["ollama"].label).toBe("Ollama-local");
    expect(byId["mock"].label).toBe("Mock");
    expect(byId["gemini"].endpoint).toBeTruthy();
    expect(byId["gemini"].models.length).toBeGreaterThan(0);
    await app.close();
  });

  it("buildProviderStatus never includes key values", () => {
    const c = cfg({ geminiApiKey: "k123", openaiApiKey: "k456", anthropicApiKey: "k789" });
    const list = buildProviderStatus(c, createProvidersFromEnv(c));
    expect(JSON.stringify(list)).not.toContain("k123");
    expect(JSON.stringify(list)).not.toContain("k456");
    expect(JSON.stringify(list)).not.toContain("k789");
  });
});

describe("chat via routed provider", () => {
  it("uses x-provider of routed adapter and isolates exact cache per provider", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    const counters = { openai: { calls: 0 }, anthropic: { calls: 0 }, mock: { calls: 0 } };
    const providers = new Map<string, ProviderAdapter>([
      ["openai", stub("openai", counters.openai)],
      ["anthropic", stub("anthropic", counters.anthropic)],
      ["mock", stub("mock", counters.mock)],
    ]);
    const fallback = providers.get("mock")!;
    registerChatRoutes(app, fallback, cfg(), cache, { providers });

    const messages = [{ role: "user" as const, content: "same prompt" }];
    const gpt = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "gpt-4o-mini", messages } });
    expect(gpt.statusCode).toBe(200);
    expect(gpt.headers["x-provider"]).toBe("openai");
    expect(gpt.headers["x-cache"]).toBe("MISS");

    const claude = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "claude-4", messages } });
    expect(claude.statusCode).toBe(200);
    expect(claude.headers["x-provider"]).toBe("anthropic");
    // Same prompt but different provider -> different exact key -> second provider call, not a HIT.
    expect(claude.headers["x-cache"]).toBe("MISS");
    expect(counters.openai.calls).toBe(1);
    expect(counters.anthropic.calls).toBe(1);

    const gptAgain = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "gpt-4o-mini", messages } });
    expect(gptAgain.headers["x-cache"]).toBe("HIT");
    expect(gptAgain.headers["x-provider"]).toBe("openai");
    expect(counters.openai.calls).toBe(1);
    expect(counters.anthropic.calls).toBe(1);
    await app.close();
  });

  it("backward compat: no providers map uses the single injected provider", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg());
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("mock");
    await app.close();
  });

  it("a :free model routes through the gateway to the openrouter adapter", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    const counters = { openrouter: { calls: 0 }, mock: { calls: 0 } };
    const providers = new Map<string, ProviderAdapter>([
      ["openrouter", stub("openrouter", counters.openrouter)],
      ["mock", stub("mock", counters.mock)],
    ]);
    registerChatRoutes(app, providers.get("mock")!, cfg(), cache, { providers });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "qwen/qwen3.8-27b:free", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("openrouter");
    expect(counters.openrouter.calls).toBe(1);
    expect(counters.mock.calls).toBe(0);
    await app.close();
  });
});

describe("anthropic auth mapping", () => {
  it("401 from Anthropic maps to 502 provider_auth_error", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad key", { status: 401 }));
    const adapter = new AnthropicAdapter({ baseURL: "https://api.anthropic.com", apiKey: "bad", defaultModel: "claude-4" });
    const err = await adapter.chat({ model: "claude-4", messages: [{ role: "user", content: "hi" }], temperature: 1, stream: false }, new AbortController().signal).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.code).toBe("provider_auth_error");
  });

  it("AnthropicAdapter maps system + content blocks + usage", async () => {
    let seenBody = "";
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      seenBody = init?.body ?? "";
      return new Response(JSON.stringify({
        id: "msg-1", model: "claude-4",
        content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
        usage: { input_tokens: 3, output_tokens: 4 },
      }), { status: 200 });
    });
    const adapter = new AnthropicAdapter({ baseURL: "https://api.anthropic.com", apiKey: "k", defaultModel: "claude-4" });
    const out = await adapter.chat({
      model: "claude-4",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      temperature: 0.5, stream: false,
    }, new AbortController().signal);
    expect(out.content).toBe("hello world");
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
    const body = JSON.parse(seenBody);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("routed chat surfaces provider_auth_error as 502 through HTTP", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad key", { status: 401 }));
    const app = Fastify();
    const providers = new Map<string, ProviderAdapter>([
      ["mock", new MockProvider()],
      ["anthropic", new AnthropicAdapter({ baseURL: "https://api.anthropic.com", apiKey: "bad", defaultModel: "claude-4" })],
    ]);
    registerChatRoutes(app, providers.get("mock")!, cfg(), new InMemoryCache(), { providers });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "claude-4", messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_auth_error");
    await app.close();
  });
});

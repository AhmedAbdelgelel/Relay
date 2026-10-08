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
import { buildExactCacheKey } from "../../src/domain/normalize.js";
import { metrics } from "../../src/observability/metrics.js";
import { GatewayError, type ChatRequest, type ChatResponse } from "../../src/domain/types.js";

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
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "", savedUsdPer1kTokens: 0,
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
    // Single-target chain: nowhere to fail over, so the auth error surfaces.
    // (With a healthy fallback in-map, T14 fails over instead — see T14 tests.)
    const anthropic = new AnthropicAdapter({ baseURL: "https://api.anthropic.com", apiKey: "bad", defaultModel: "claude-4" });
    const providers = new Map<string, ProviderAdapter>([["anthropic", anthropic]]);
    registerChatRoutes(app, anthropic, cfg(), new InMemoryCache(), { providers });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "claude-4", messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_auth_error");
    await app.close();
  });
});

describe("T14 fallback", () => {
  function mockCounted(name: string, failure: "rate_limited" | "server_error" | null, counter: { calls: number }): ProviderAdapter {
    const inner = new MockProvider({ delayMs: 0, failure });
    return {
      name,
      capabilities: inner.capabilities,
      async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
        counter.calls++;
        return inner.chat(req, signal);
      },
      async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
        counter.calls++;
        yield* inner.chatStream(req, signal);
      },
    };
  }

  function fallbackApp(primary: ProviderAdapter, fallback: ProviderAdapter) {
    const providers = new Map<string, ProviderAdapter>([
      ["primary", primary],
      ["fallback", fallback],
    ]);
    const app = Fastify();
    const cache = new InMemoryCache();
    registerChatRoutes(app, primary, cfg(), cache, { providers });
    return { app, providers, cache };
  }

  it("primary 500 -> automatic 200 from fallback with x-fallback", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const primary = mockCounted("alpha", "server_error", primaryCalls);
    const fallback = mockCounted("beta", null, fallbackCalls);
    const { app } = fallbackApp(primary, fallback);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 primary 500" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("beta");
    expect(res.headers["x-fallback"]).toBe("true");
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.json().choices[0].message.content).toContain("mock echo");
    expect(primaryCalls.calls).toBe(3);
    expect(fallbackCalls.calls).toBe(1);
    const snap = (await app.inject({ method: "GET", url: "/metrics" })).json() as { fallback_count: number };
    expect(snap.fallback_count).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("all targets down -> 502 with no leaked internals", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const primary = mockCounted("alpha", "server_error", primaryCalls);
    const fallback = mockCounted("beta", "server_error", fallbackCalls);
    const { app } = fallbackApp(primary, fallback);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 all down" }] },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBeTruthy();
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.message).toBeTruthy();
    const raw = res.body;
    expect(raw).not.toContain("node_modules");
    expect(raw).not.toContain("GatewayError");
    expect(raw).not.toMatch(/\.ts:\d+/);
    expect(raw).not.toContain("at ");
    expect(primaryCalls.calls).toBe(3);
    expect(fallbackCalls.calls).toBe(3);
    const snap = (await app.inject({ method: "GET", url: "/metrics" })).json() as { provider_errors: number; fallback_count: number };
    expect(snap.provider_errors).toBeGreaterThanOrEqual(1);
    expect(snap.fallback_count).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("breaker opens and skips the primary while fallback serves", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const primary = mockCounted("alpha", "server_error", primaryCalls);
    const fallback = mockCounted("beta", null, fallbackCalls);
    const { app } = fallbackApp(primary, fallback);
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "m", messages: [{ role: "user", content: `t14 breaker ${i}` }] },
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers["x-fallback"]).toBe("true");
    }
    expect(primaryCalls.calls).toBe(9);
    expect(fallbackCalls.calls).toBe(3);
    const snapOpen = (await app.inject({ method: "GET", url: "/metrics" })).json() as { breaker_open: number };
    expect(snapOpen.breaker_open).toBe(1);
    const probe = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 breaker probe" }] },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.headers["x-provider"]).toBe("beta");
    expect(probe.headers["x-fallback"]).toBe("true");
    expect(primaryCalls.calls).toBe(9);
    expect(fallbackCalls.calls).toBe(4);
    const snapStill = (await app.inject({ method: "GET", url: "/metrics" })).json() as { breaker_open: number };
    expect(snapStill.breaker_open).toBe(1);
    await app.close();
  });

  it("streaming pre-first-token failover serves a full SSE stream from fallback", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const primary = mockCounted("alpha", "server_error", primaryCalls);
    const fallback = mockCounted("beta", null, fallbackCalls);
    const { app } = fallbackApp(primary, fallback);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 stream failover" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-provider"]).toBe("beta");
    expect(res.headers["x-fallback"]).toBe("true");
    expect(res.body).toContain("data: [DONE]");
    expect(res.body).toContain("mock ");
    expect(primaryCalls.calls).toBe(3);
    expect(fallbackCalls.calls).toBe(1);
    const snap = (await app.inject({ method: "GET", url: "/metrics" })).json() as { fallback_count: number };
    expect(snap.fallback_count).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("no mid-SSE provider switch: partial chunk kept, fallback never called", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const oneChunkFail: ProviderAdapter = {
      name: "alpha",
      capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true },
      async chat(_req: ChatRequest, _signal: AbortSignal): Promise<ChatResponse> {
        primaryCalls.calls++;
        throw new GatewayError(502, "provider_error", "mid fail", true);
      },
      async *chatStream(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<StreamChunk> {
        primaryCalls.calls++;
        yield { delta: "partial-" };
        throw new GatewayError(502, "provider_error", "mid-stream boom", true);
      },
    };
    const fallback = stub("beta", fallbackCalls);
    const providers = new Map<string, ProviderAdapter>([["primary", oneChunkFail], ["fallback", fallback]]);
    const app = Fastify();
    registerChatRoutes(app, oneChunkFail, cfg(), new InMemoryCache(), { providers });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 mid stream" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("alpha");
    expect(res.body).toContain("partial-");
    expect(res.body).not.toContain("beta reply");
    expect(res.body).not.toContain("data: [DONE]");
    expect(primaryCalls.calls).toBe(1);
    expect(fallbackCalls.calls).toBe(0);
    await app.close();
  });

  it("fallback answers live under the serving key only (INV-7)", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const primary = mockCounted("alpha", "server_error", primaryCalls);
    const fallback = mockCounted("beta", null, fallbackCalls);
    const { app, cache } = fallbackApp(primary, fallback);
    const messages = [{ role: "user" as const, content: "t14 serving key probe" }];
    const payload = { model: "m", messages };
    const canonical = { model: "m", messages, temperature: 1.0, stream: false };
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.headers["x-provider"]).toBe("beta");
    expect(first.headers["x-fallback"]).toBe("true");
    expect(primaryCalls.calls).toBe(3);
    expect(fallbackCalls.calls).toBe(1);
    const primaryKey = buildExactCacheKey("alpha", canonical).key;
    const servingKey = buildExactCacheKey("beta", canonical).key;
    expect(primaryKey).not.toBe(servingKey);
    expect(await cache.get(primaryKey)).toBeNull();
    expect(await cache.get(servingKey)).not.toBeNull();
    for (const p of ["t14 serving key trip 1", "t14 serving key trip 2"]) {
      const r = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: p }] } });
      expect(r.statusCode).toBe(200);
      expect(r.headers["x-fallback"]).toBe("true");
    }
    expect(primaryCalls.calls).toBe(9);
    expect(fallbackCalls.calls).toBe(3);
    expect(((await app.inject({ method: "GET", url: "/metrics" })).json() as { breaker_open: number }).breaker_open).toBe(1);
    const replay = await app.inject({ method: "POST", url: "/v1/chat/completions", payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["x-cache"]).toBe("HIT");
    expect(replay.headers["x-provider"]).toBe("beta");
    expect(replay.headers["x-fallback"]).toBe("true");
    expect(primaryCalls.calls).toBe(9);
    expect(fallbackCalls.calls).toBe(3);
    await app.close();
  });

  it("non-retryable failure fails over after exactly 1 primary attempt", async () => {
    metrics.reset();
    const primaryCalls = { calls: 0 };
    const fallbackCalls = { calls: 0 };
    const fatal: ProviderAdapter = {
      name: "gamma",
      capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true },
      async chat(req: ChatRequest, _signal: AbortSignal): Promise<ChatResponse> {
        primaryCalls.calls++;
        throw new GatewayError(502, "provider_not_found", "no such model", false);
      },
      async *chatStream(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<StreamChunk> {
        primaryCalls.calls++;
        throw new GatewayError(502, "provider_not_found", "no such model", false);
      },
    };
    const fallback = mockCounted("beta", null, fallbackCalls);
    const providers = new Map<string, ProviderAdapter>([["primary", fatal], ["fallback", fallback]]);
    const app = Fastify();
    registerChatRoutes(app, fatal, cfg(), new InMemoryCache(), { providers });
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 fatal failover" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-provider"]).toBe("beta");
    expect(res.headers["x-fallback"]).toBe("true");
    expect(primaryCalls.calls).toBe(1);
    expect(fallbackCalls.calls).toBe(1);
    expect(res.json().model).toBe("m");
    const streamRes = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "t14 fatal stream" }], stream: true },
    });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers["x-provider"]).toBe("beta");
    expect(streamRes.headers["x-fallback"]).toBe("true");
    expect(streamRes.body).toContain("data: [DONE]");
    expect(primaryCalls.calls).toBe(2);
    expect(fallbackCalls.calls).toBe(2);
    await app.close();
  });
});

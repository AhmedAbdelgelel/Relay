import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { RedisCache } from "../../src/cache/RedisCache.js";
import { createCacheFromEnv } from "../../src/cache/factory.js";
import { buildExactCacheKey } from "../../src/domain/normalize.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    ...over,
  };
}

const body = { model: "m", messages: [{ role: "user", content: "hello" }] };

describe("exact cache (cache-aside, non-stream only)", () => {
  it("second identical request is a HIT and provider runs once", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    let calls = 0;
    const provider = new MockProvider();
    const orig = provider.chat.bind(provider);
    provider.chat = (async (...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
    registerChatRoutes(app, provider, cfg(), cache);
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.json().choices[0].message.content).toBe(first.json().choices[0].message.content);
    expect(calls).toBe(1);
    await app.close();
  });

  it("different prompt is a MISS", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    registerChatRoutes(app, new MockProvider(), cfg(), cache);
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    const other = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "something else" }] },
    });
    expect(other.headers["x-cache"]).toBe("MISS");
    await app.close();
  });

  it("padded whitespace hits the same entry", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    registerChatRoutes(app, new MockProvider(), cfg(), cache);
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    const padded = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "  hello  " }] },
    });
    expect(padded.headers["x-cache"]).toBe("HIT");
    await app.close();
  });

  it("stream:true bypasses cache", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    registerChatRoutes(app, new MockProvider(), cfg(), cache);
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { ...body, stream: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    await app.close();
  });

  it("malformed entry is evicted and served as MISS", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    const provider = new MockProvider();
    registerChatRoutes(app, provider, cfg(), cache);
    const { key } = buildExactCacheKey("mock", {
      model: "m", messages: [{ role: "user", content: "hello" }], temperature: 1, stream: false,
    });
    await cache.set(key, "not-json{{{", 3600);
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    const retry = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(retry.headers["x-cache"]).toBe("HIT");
    await app.close();
  });

  it("cache disabled returns DISABLED and never stores", async () => {
    const app = Fastify();
    const cache = new InMemoryCache();
    registerChatRoutes(app, new MockProvider(), cfg({ cacheEnabled: false }), cache);
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(first.headers["x-cache"]).toBe("DISABLED");
    expect(second.headers["x-cache"]).toBe("DISABLED");
    expect(await cache.get("llm:exact:v1:mock:anything")).toBeNull();
    await app.close();
  });

  it("dead Redis degrades to MISS with 200, never 5xx", async () => {
    const app = Fastify();
    const cache = new RedisCache({ url: "redis://127.0.0.1:6399", commandTimeoutMs: 200 });
    registerChatRoutes(app, new MockProvider(), cfg(), cache);
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    await app.close();
    await cache.close();
  });

  it("factory returns redis when REDIS_URL set, memory otherwise", () => {
    expect(createCacheFromEnv(cfg()).name).toBe("memory");
    expect(createCacheFromEnv(cfg({ redisUrl: "redis://127.0.0.1:6379" })).name).toBe("redis");
  });
});

// D3: the client can prove WHY it hit or missed — same hash on the MISS that
// stored the entry and on the HIT that served it, always equal to
// buildExactCacheKey(...).hash, present even when the cache is bypassed/disabled.
describe("x-cache-hash (D3)", () => {
  const expected = () =>
    buildExactCacheKey("mock", {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      temperature: 1,
      stream: false,
    }).hash;

  it("identical request: MISS and HIT expose the same hash", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache());
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(first.headers["x-cache-hash"]).toBe(expected());
    expect(second.headers["x-cache-hash"]).toBe(expected());
    await app.close();
  });

  it("stream BYPASS still reports the key it would have used", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache());
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { ...body, stream: true } });
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-cache-hash"]).toBe(expected());
    await app.close();
  });

  it("cache disabled (DISABLED) still reports the hash", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg({ cacheEnabled: false }), new InMemoryCache());
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    expect(res.headers["x-cache"]).toBe("DISABLED");
    expect(res.headers["x-cache-hash"]).toBe(expected());
    await app.close();
  });

  it("hash follows identity rules: whitespace-trimmed same, temperature/prompt differ", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache());
    const base = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: body });
    const padded = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "  hello  " }] },
    });
    const other = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { ...body, temperature: 0.1 },
    });
    expect(padded.headers["x-cache-hash"]).toBe(base.headers["x-cache-hash"]);
    expect(other.headers["x-cache-hash"]).not.toBe(base.headers["x-cache-hash"]);
    await app.close();
  });
});

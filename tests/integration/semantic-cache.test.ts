import { describe, expect, it, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import { metrics } from "../../src/observability/metrics.js";
import { MockProvider } from "../../src/providers/MockProvider.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "gpt-4o-mini",
    anthropicApiKey: "", anthropicBaseUrl: "https://api.anthropic.com", anthropicModel: "claude-4",
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: true, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "", gatewayApiKeys: [], credEncKey: "",
    ...over,
  };
}

function unit(i: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

/** Test double: gateway-topic prompts share one vector, everything else orthogonal. */
class ParaphraseEmbedder implements EmbeddingProvider {
  readonly name = "test-paraphrase";
  readonly dimension = EMBEDDING_DIM;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    if (text.toLowerCase().includes("gateway")) return unit(0);
    return unit(1);
  }
}

beforeEach(() => metrics.reset());

describe("semantic cache e2e (L2: exact MISS -> semantic -> policy -> provider)", () => {
  it("paraphrase reuses first answer with SEMANTIC_HIT and provider runs once", async () => {
    const app = Fastify();
    const store = new InMemoryVectorStore();
    let calls = 0;
    const provider = new MockProvider();
    const orig = provider.chat.bind(provider);
    provider.chat = (async (...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;
    registerChatRoutes(app, provider, cfg(), new InMemoryCache(), { semanticStore: store, embedder: new ParaphraseEmbedder() });

    const first = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");

    const second = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "m", messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("SEMANTIC_HIT");
    expect(second.headers["x-semantic-similarity"]).toBe("1.0000");
    expect(second.json().choices[0].message.content).toBe(first.json().choices[0].message.content);
    expect(calls).toBe(1);

    const snap = await app.inject({ method: "GET", url: "/metrics" });
    expect(snap.json().semantic_hits).toBe(1);
    await app.close();
  });

  it("unrelated prompt is a MISS (no false positive)", async () => {
    const app = Fastify();
    const store = new InMemoryVectorStore();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache(), { semanticStore: store, embedder: new ParaphraseEmbedder() });
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] } });
    const other = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "Give me a BBQ ribs recipe" }] } });
    expect(other.headers["x-cache"]).toBe("MISS");
    await app.close();
  });

  it("policy blocks reuse across model / temperature / tenant", async () => {
    const app = Fastify();
    const store = new InMemoryVectorStore();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache(), { semanticStore: store, embedder: new ParaphraseEmbedder() });
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] } });

    const diffModel = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "other", messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] } });
    expect(diffModel.headers["x-cache"]).toBe("MISS");

    const diffTemp = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", temperature: 0.1, messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] } });
    expect(diffTemp.headers["x-cache"]).toBe("MISS");

    const diffTenant = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: { "x-tenant-id": "tenant-b" },
      payload: { model: "m", messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] },
    });
    expect(diffTenant.headers["x-cache"]).toBe("MISS");
    await app.close();
  });

  it("stream:true bypasses semantic (BYPASS, never SEMANTIC_HIT)", async () => {
    const app = Fastify();
    const store = new InMemoryVectorStore();
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache(), { semanticStore: store, embedder: new ParaphraseEmbedder() });
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] } });
    const s = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", stream: true, messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] } });
    expect(s.headers["x-cache"]).toBe("BYPASS");
    await app.close();
  });

  it("semantic disabled falls back to MISS (exact only)", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MockProvider(), cfg({ semanticEnabled: false }), new InMemoryCache());
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "What is an LLM gateway?" }] } });
    const para = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "Explain what an LLM gateway does?" }] } });
    expect(para.headers["x-cache"]).toBe("MISS");
    await app.close();
  });

  it("below-threshold candidate is not reused", async () => {
    const app = Fastify();
    const store = new InMemoryVectorStore();
    // Save with unit(0); query with 0.90-similar vector; threshold 0.92 -> MISS.
    const rotator: EmbeddingProvider = {
      name: "test-rotator",
      dimension: EMBEDDING_DIM,
      async embed(text: string) {
        if (text.includes("SECOND")) {
          const v = unit(0).slice();
          v[0] = 0.9;
          v[1] = Math.sqrt(1 - 0.81);
          return v;
        }
        return unit(0);
      },
    };
    registerChatRoutes(app, new MockProvider(), cfg({ semanticThreshold: 0.92 }), new InMemoryCache(), { semanticStore: store, embedder: rotator });
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "FIRST gateway question" }] } });
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "SECOND gateway question" }] } });
    expect(second.headers["x-cache"]).toBe("MISS");
    await app.close();
  });

  it("semantic failure degrades to MISS, never 5xx", async () => {
    const app = Fastify();
    const brokenStore = new InMemoryVectorStore();
    brokenStore.findSimilar = async () => { throw new Error("vector db down"); };
    const brokenEmbedder: EmbeddingProvider = {
      name: "test-broken",
      dimension: EMBEDDING_DIM,
      async embed() { throw new Error("embedder down"); },
    };
    registerChatRoutes(app, new MockProvider(), cfg(), new InMemoryCache(), { semanticStore: brokenStore, embedder: brokenEmbedder });
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "m", messages: [{ role: "user", content: "hello" }] } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    await app.close();
  });
});

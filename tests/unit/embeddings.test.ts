import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, promptTextForEmbedding } from "../../src/embeddings/EmbeddingProvider.js";
import { MockEmbedding } from "../../src/embeddings/MockEmbedding.js";
import { createEmbedderFromEnv } from "../../src/embeddings/factory.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000,
    provider: "mock",
    upstreamTimeoutMs: 5000,
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
    openRouterKey: "", openRouterBaseUrl: "https://openrouter.ai/api/v1", openRouterModel: "nvidia/nemotron-3-super-120b-a12b:free",
    redisUrl: "",
    cacheTtlSec: 3600,
    cacheEnabled: true,
    embeddingProvider: "mock",
    embeddingModel: "",
    semanticEnabled: true,
    semanticThreshold: 0.92,
    semanticTopK: 3,
    semanticTtlSec: 3600,
    semanticStore: "memory",
    databaseUrl: "",
    ...over,
  };
}

describe("embeddings", () => {
  it("promptTextForEmbedding is role-tagged and trims (system matters)", () => {
    const a = promptTextForEmbedding({ model: "m", messages: [{ role: "user", content: "  hi  " }] } as any);
    expect(a).toBe("user: hi");
    const b = promptTextForEmbedding({
      model: "m",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    } as any);
    expect(b).toBe("system: be brief\nuser: hi");
    const c = promptTextForEmbedding({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(b).not.toBe(c); // system prompt changes the embedding input
  });

  it("MockEmbedding is deterministic with correct dim and unit norm", async () => {
    const m = new MockEmbedding();
    expect(m.dimension).toBe(EMBEDDING_DIM);
    const signal = new AbortController().signal;
    const v1 = await m.embed("hello", signal);
    const v2 = await m.embed("hello", signal);
    expect(v1).toHaveLength(EMBEDDING_DIM);
    expect(v1).toEqual(v2);
    const norm = Math.sqrt(v1.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("MockEmbedding: different texts are quasi-orthogonal (safe, never false-hit)", async () => {
    const m = new MockEmbedding();
    const signal = new AbortController().signal;
    const a = await m.embed("what is the capital of France?", signal);
    const b = await m.embed("how do I bake sourdough?", signal);
    const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(Math.abs(dot)).toBeLessThan(0.25);
  });

  it("factory chooses mock/ollama/gemini", () => {
    expect(createEmbedderFromEnv(cfg({ embeddingProvider: "mock" })).name).toBe("mock");
    expect(createEmbedderFromEnv(cfg({ embeddingProvider: "ollama" })).name).toBe("ollama");
    expect(
      createEmbedderFromEnv(cfg({ embeddingProvider: "gemini", geminiApiKey: "k" })).name,
    ).toBe("gemini");
  });

  it("factory: gemini without key throws a clear error", () => {
    expect(() => createEmbedderFromEnv(cfg({ embeddingProvider: "gemini", geminiApiKey: "" }))).toThrow(
      /GEMINI_API_KEY/,
    );
  });
});

// Response Processor wired into the gateway: every answer the client receives is
// stripped of presentation markup, and the caches store the normalized text.
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import type { GatewayConfig } from "../../src/infrastructure/config.js";
import type { ChatRequest, ChatResponse } from "../../src/domain/types.js";
import type { ProviderAdapter, StreamChunk } from "../../src/providers/ProviderAdapter.js";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000, provider: "mock", upstreamTimeoutMs: 2000,
    geminiApiKey: "", geminiModel: "gemini-3.6-flash",
    geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollamaBaseUrl: "http://localhost:11434/v1", ollamaModel: "llama3.1:8b",
    openaiApiKey: "", openaiBaseUrl: "https://api.openai.com/v1",
    redisUrl: "", cacheTtlSec: 3600, cacheEnabled: true,
    embeddingProvider: "mock", embeddingModel: "",
    semanticEnabled: false, semanticThreshold: 0.92, semanticTopK: 3,
    semanticTtlSec: 3600, semanticStore: "memory", databaseUrl: "",
    ...over,
  } as GatewayConfig;
}

/** Provider that returns a fixed markdown answer, chunked a given way. */
class MarkdownProvider implements ProviderAdapter {
  readonly name = "mock";
  constructor(
    private readonly answer: string,
    private readonly pieces: string[] = [],
  ) {}
  async chat(_req: ChatRequest, _signal: AbortSignal): Promise<ChatResponse> {
    return { id: "md-1", model: "m", content: this.answer, usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
  async *chatStream(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<StreamChunk> {
    for (const p of this.pieces.length ? this.pieces : [this.answer]) {
      yield { delta: p };
    }
    yield { delta: "", usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
}

const chatBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
const post = (id: string) => ({
  method: "POST" as const,
  url: "/v1/chat/completions",
  payload: chatBody,
  headers: { "x-request-id": id },
});
const postStream = (id: string) => ({
  method: "POST" as const,
  url: "/v1/chat/completions",
  payload: { ...chatBody, stream: true },
  headers: { "x-request-id": id },
});

/** Read every SSE content delta out of a raw stream body. */
function sseText(raw: string): string {
  let out = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const d = t.slice(5).trim();
    if (d === "[DONE]") continue;
    try {
      const j = JSON.parse(d);
      out += j.choices?.[0]?.delta?.content ?? "";
    } catch { /* non-JSON frame */ }
  }
  return out;
}

describe("response normalizer through the gateway (non-stream)", () => {
  it("strips markdown before the client sees it", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MarkdownProvider("## Title\n\n**bold** and *italic*"), cfg(), new InMemoryCache());
    const res = await app.inject(post("norm-1"));
    expect(res.statusCode).toBe(200);
    const content = res.json().choices[0].message.content;
    expect(content).not.toContain("**");
    expect(content).not.toContain("##");
    expect(content).not.toContain("*italic*");
    expect(content).toContain("Title");
    expect(content).toContain("bold");
    expect(content).toContain("italic");
    await app.close();
  });

  it("stores the NORMALIZED text in the exact cache", async () => {
    const cache = new InMemoryCache();
    const app = Fastify();
    registerChatRoutes(app, new MarkdownProvider("**only bold**"), cfg(), cache);
    const first = await app.inject(post("norm-2"));
    expect(first.json().choices[0].message.content).toBe("only bold");

    const second = await app.inject(post("norm-2"));
    expect(second.headers["x-cache"]).toBe("HIT");
    // The cached blob must already be clean, otherwise a later HIT would
    // re-serve raw markdown the first caller never saw.
    expect(second.json().choices[0].message.content).toBe("only bold");
    expect(second.json().choices[0].message.content).not.toContain("**");
    await app.close();
  });

  it("leaves code block contents untouched", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MarkdownProvider("```js\nconst a = **1**;\n```"), cfg(), new InMemoryCache());
    const res = await app.inject(post("norm-3"));
    const content = res.json().choices[0].message.content;
    expect(content).toContain("**1**");
    expect(content).not.toContain("```");
    await app.close();
  });
});

describe("response normalizer through the gateway (SSE)", () => {
  it("normalizes a stream whose markers straddle chunk boundaries", async () => {
    const app = Fastify();
    // Deliberately split mid-marker: naive per-chunk stripping emits "bold**".
    const pieces = ["## Head", "ing\n\n**bo", "ld** and ", "text"];
    registerChatRoutes(app, new MarkdownProvider("", pieces), cfg(), new InMemoryCache());
    const res = await app.inject(postStream("norm-4"));
    expect(res.statusCode).toBe(200);
    const text = sseText(res.body);
    expect(text).not.toContain("**");
    expect(text).not.toContain("##");
    expect(text).not.toContain("bold**");
    expect(text).toContain("Heading");
    expect(text).toContain("bold and text");
    await app.close();
  });

  it("still reports BYPASS, TTFT and the terminal usage frame", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MarkdownProvider("**x**", ["**", "x", "**"]), cfg(), new InMemoryCache());
    const res = await app.inject(postStream("norm-5"));
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-latency-ms"]).toBeTruthy();
    expect(res.body).toContain("prompt_tokens");
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    await app.close();
  });

  it("an empty stream still closes cleanly with [DONE]", async () => {
    const app = Fastify();
    registerChatRoutes(app, new MarkdownProvider("", []), cfg(), new InMemoryCache());
    const res = await app.inject(postStream("norm-5"));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("data: [DONE]");
    await app.close();
  });
});
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatRole,
  TokenUsage,
} from "../../src/domain/types.js";
import { GatewayError } from "../../src/domain/types.js";
import type {
  GatewayConfig,
  ProviderName,
} from "../../src/infrastructure/config.js";
import { loadConfig } from "../../src/infrastructure/config.js";
import {
  providerHttpError,
  toGatewayError,
} from "../../src/infrastructure/errors.js";
import type { ProviderAdapter, StreamChunk } from "../../src/providers/ProviderAdapter.js";
import { MockProvider } from "../../src/providers/MockProvider.js";
import type { MockFailure } from "../../src/providers/MockProvider.js";
import { OpenAICompatibleProvider } from "../../src/providers/OpenAICompatibleProvider.js";
import type { OpenAICompatibleOpts } from "../../src/providers/OpenAICompatibleProvider.js";
import { createProviderFromEnv } from "../../src/providers/factory.js";

// Type tests: compile-time (expectTypeOf) + runtime (expect) for EVERY
// domain/infra/provider type. If any shape drifts, `npm run typecheck`
// (tsconfig.check.json covers src+tests) AND `npm test` both fail.

describe("domain types", () => {
  it("ChatRole is exactly system|user|assistant", () => {
    expectTypeOf<ChatRole>().toEqualTypeOf<"system" | "user" | "assistant">();
    const roles: ChatRole[] = ["system", "user", "assistant"];
    expect(roles).toHaveLength(3);
    // @ts-expect-error - invalid role must not compile
    const bad: ChatRole = "admin";
    expect(bad).toBe("admin"); // unreachable at runtime; compile error is the assertion
  });

  it("ChatMessage has role + string content", () => {
    expectTypeOf<ChatMessage>().toEqualTypeOf<{ role: ChatRole; content: string }>();
    const m: ChatMessage = { role: "user", content: "hi" };
    expectTypeOf(m.role).toEqualTypeOf<ChatRole>();
    expectTypeOf(m.content).toEqualTypeOf<string>();
    expect(m.content).toBe("hi");
  });

  it("ChatRequest shape: model/messages/temperature/stream + optional max_tokens", () => {
    expectTypeOf<ChatRequest["model"]>().toEqualTypeOf<string>();
    expectTypeOf<ChatRequest["messages"]>().toEqualTypeOf<ChatMessage[]>();
    expectTypeOf<ChatRequest["temperature"]>().toEqualTypeOf<number>();
    expectTypeOf<ChatRequest["stream"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ChatRequest["max_tokens"]>().toEqualTypeOf<number | undefined>();

    const req: ChatRequest = {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
      stream: false,
    };
    expect(req.temperature).toBe(1);
    expect(req.max_tokens).toBeUndefined();
    const withTokens: ChatRequest = { ...req, max_tokens: 128 };
    expect(withTokens.max_tokens).toBe(128);
  });

  it("ChatResponse shape: id/model/content + optional usage", () => {
    expectTypeOf<ChatResponse["id"]>().toEqualTypeOf<string>();
    expectTypeOf<ChatResponse["model"]>().toEqualTypeOf<string>();
    expectTypeOf<ChatResponse["content"]>().toEqualTypeOf<string>();
    expectTypeOf<ChatResponse["usage"]>().toEqualTypeOf<TokenUsage | undefined>();
    // TokenUsage is the single accounting shape shared by chat() and chatStream().
    expectTypeOf<TokenUsage>().toEqualTypeOf<{ prompt_tokens: number; completion_tokens: number }>();

    const res: ChatResponse = {
      id: "mock-1",
      model: "m",
      content: "hello",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(res.usage?.prompt_tokens).toBe(10);
    const noUsage: ChatResponse = { id: "x", model: "m", content: "c" };
    expect(noUsage.usage).toBeUndefined();
  });

  it("GatewayError is an Error with status/code/retryable", () => {
    const err = new GatewayError(504, "gateway_timeout", "timed out", true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GatewayError);
    expectTypeOf(err.status).toEqualTypeOf<number>();
    expectTypeOf(err.code).toEqualTypeOf<string>();
    expectTypeOf(err.retryable).toEqualTypeOf<boolean>();
    expect(err.status).toBe(504);
    expect(err.code).toBe("gateway_timeout");
    expect(err.retryable).toBe(true);
  });
});

describe("config types", () => {
  it("ProviderName is mock|gemini|ollama|openai", () => {
    expectTypeOf<ProviderName>().toEqualTypeOf<"mock" | "gemini" | "ollama" | "openai">();
  });

  it("GatewayConfig has all required fields with correct types", () => {
    expectTypeOf<GatewayConfig["port"]>().toEqualTypeOf<number>();
    expectTypeOf<GatewayConfig["provider"]>().toEqualTypeOf<ProviderName>();
    expectTypeOf<GatewayConfig["upstreamTimeoutMs"]>().toEqualTypeOf<number>();
    expectTypeOf<GatewayConfig["geminiApiKey"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["geminiModel"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["geminiBaseUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["ollamaBaseUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["ollamaModel"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["openaiApiKey"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["openaiBaseUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["redisUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<GatewayConfig["cacheTtlSec"]>().toEqualTypeOf<number>();
    expectTypeOf<GatewayConfig["cacheEnabled"]>().toEqualTypeOf<boolean>();

    const cfg = loadConfig({ ...process.env, PROVIDER: "mock" });
    expectTypeOf(cfg).toEqualTypeOf<GatewayConfig>();
    expect(cfg.provider).toBe("mock");
    expect(typeof cfg.port).toBe("number");
  });
});

describe("provider types", () => {
  it("ProviderAdapter interface: name + chat + chatStream", () => {
    expectTypeOf<ProviderAdapter["name"]>().toEqualTypeOf<string>();
    expectTypeOf<ProviderAdapter["chat"]>().toEqualTypeOf<
      (req: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>
    >();
    // D1 contract: streamed pieces carry delta + optional terminal usage.
    expectTypeOf<ProviderAdapter["chatStream"]>().toEqualTypeOf<
      (req: ChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk>
    >();
    expectTypeOf<StreamChunk>().toEqualTypeOf<{ delta: string; usage?: TokenUsage }>();
    expectTypeOf<StreamChunk["delta"]>().toEqualTypeOf<string>();
    expectTypeOf<StreamChunk["usage"]>().toEqualTypeOf<TokenUsage | undefined>();
  });

  it("MockProvider satisfies ProviderAdapter; MockFailure union holds", () => {
    expectTypeOf<MockFailure>().toEqualTypeOf<"rate_limited" | "server_error" | null>();
    const p: ProviderAdapter = new MockProvider();
    expectTypeOf(p).toMatchTypeOf<ProviderAdapter>();
    expect(p.name).toBe("mock");
    expectTypeOf(p.chat).toEqualTypeOf<ProviderAdapter["chat"]>();
  });

  it("OpenAICompatibleOpts + OpenAICompatibleProvider satisfy ProviderAdapter", () => {
    expectTypeOf<OpenAICompatibleOpts>().toEqualTypeOf<{
      name: string;
      baseURL: string;
      apiKey: string;
      defaultModel: string;
    }>();
    const p: ProviderAdapter = new OpenAICompatibleProvider({
      name: "gemini",
      baseURL: "https://example.com",
      apiKey: "k",
      defaultModel: "gemini-3.6-flash",
    });
    expect(p.name).toBe("gemini");
  });

  it("factory returns a ProviderAdapter for every ProviderName", () => {
    expectTypeOf<typeof createProviderFromEnv>().returns.toEqualTypeOf<ProviderAdapter>();
    const base: GatewayConfig = {
      port: 3000,
      provider: "mock",
      upstreamTimeoutMs: 100,
      geminiApiKey: "",
      geminiModel: "gemini-3.6-flash",
      geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      ollamaBaseUrl: "http://localhost:11434/v1",
      ollamaModel: "llama3.1:8b",
      openaiApiKey: "",
      openaiBaseUrl: "https://api.openai.com/v1",
      redisUrl: "",
      cacheTtlSec: 3600,
      cacheEnabled: true,
    };
    const mock: ProviderAdapter = createProviderFromEnv({ ...base, provider: "mock" });
    expect(mock.name).toBe("mock");
  });
});

describe("error helper types", () => {
  it("providerHttpError / toGatewayError always return GatewayError", () => {
    expectTypeOf<typeof providerHttpError>().returns.toEqualTypeOf<GatewayError>();
    expectTypeOf<typeof toGatewayError>().returns.toEqualTypeOf<GatewayError>();

    const e429 = providerHttpError("gemini", 429, "slow down");
    expect(e429).toBeInstanceOf(GatewayError);
    expect(e429.status).toBe(429);
    expect(e429.code).toBe("provider_rate_limited");

    const eTimeout = toGatewayError("gemini", Object.assign(new Error("x"), { name: "AbortError" }));
    expect(eTimeout.status).toBe(504);
    expect(eTimeout.code).toBe("gateway_timeout");
  });
});

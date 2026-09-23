import { describe, expect, it } from "vitest";
import { buildExactCacheKey, canonicalJson, normalizeChatRequest } from "../../src/domain/normalize.js";
import type { ChatRequest } from "../../src/domain/types.js";

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "hello" }],
    temperature: 1,
    stream: false,
    ...over,
  };
}

describe("normalize + canonical key (Day 2)", () => {
  it("same logical request, different field order/case of JSON -> same key", () => {
    const a = buildExactCacheKey("mock", req());
    const b = buildExactCacheKey("mock", req({ messages: [{ role: "user", content: "hello" }] }));
    expect(a.key).toBe(b.key);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("temperature default 1.0 equals explicit 1.0 (no false miss)", () => {
    const explicit = buildExactCacheKey("mock", req({ temperature: 1 }));
    const fromZodDefault = buildExactCacheKey("mock", req({ temperature: 1.0 }));
    expect(explicit.key).toBe(fromZodDefault.key);
  });

  it("leading/trailing whitespace is insignificant, internal is not", () => {
    const padded = buildExactCacheKey("mock", req({ messages: [{ role: "user", content: "  hello  " }] }));
    const plain = buildExactCacheKey("mock", req());
    expect(padded.key).toBe(plain.key);
    const inner = buildExactCacheKey("mock", req({ messages: [{ role: "user", content: "hel  lo" }] }));
    expect(inner.key).not.toBe(plain.key);
  });

  it("message order, model, temperature, max_tokens all affect identity", () => {
    const base = buildExactCacheKey("mock", req()).key;
    expect(buildExactCacheKey("mock", req({ model: "other" })).key).not.toBe(base);
    expect(buildExactCacheKey("mock", req({ temperature: 0 })).key).not.toBe(base);
    expect(buildExactCacheKey("mock", req({ max_tokens: 128 })).key).not.toBe(base);
    expect(
      buildExactCacheKey("mock", req({ messages: [{ role: "user", content: "bye" }] })).key,
    ).not.toBe(base);
    const two = req({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
    const swapped = req({ messages: [{ role: "user", content: "b" }, { role: "user", content: "a" }] });
    expect(buildExactCacheKey("mock", two).key).not.toBe(buildExactCacheKey("mock", swapped).key);
  });

  it("provider scopes the key (mock echo never hits Gemini entry)", () => {
    expect(buildExactCacheKey("mock", req()).key).not.toBe(buildExactCacheKey("gemini", req()).key);
  });

  it("canonicalJson sorts keys so field order never matters", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("normalize drops stream + undefined max_tokens", () => {
    const n = normalizeChatRequest(req({ stream: true }));
    expect(n).not.toHaveProperty("stream");
    expect(n).not.toHaveProperty("max_tokens");
  });
});

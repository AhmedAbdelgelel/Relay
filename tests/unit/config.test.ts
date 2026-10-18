import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";

function load(env: Record<string, string>): ReturnType<typeof loadConfig> {
  return loadConfig(env as NodeJS.ProcessEnv);
}

describe("numeric config parsing", () => {
  it("unset numeric keys keep their defaults", () => {
    const cfg = load({});
    expect(cfg.port).toBe(3000);
    expect(cfg.upstreamTimeoutMs).toBe(25000);
    expect(cfg.cacheTtlSec).toBe(3600);
    expect(cfg.semanticThreshold).toBe(0.92);
    expect(cfg.semanticTopK).toBe(3);
    expect(cfg.semanticTtlSec).toBe(3600);
    expect(cfg.savedUsdPer1kTokens).toBe(0);
  });

  it("empty and whitespace-only numeric keys keep their defaults", () => {
    const cfg = load({
      PORT: "",
      UPSTREAM_TIMEOUT_MS: "   ",
      CACHE_TTL_S: "",
      SEMANTIC_THRESHOLD: " ",
      SEMANTIC_TOP_K: "",
      SEMANTIC_TTL_S: "\t",
      SAVED_USD_PER_1K_TOKENS: "  ",
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.upstreamTimeoutMs).toBe(25000);
    expect(cfg.cacheTtlSec).toBe(3600);
    expect(cfg.semanticThreshold).toBe(0.92);
    expect(cfg.semanticTopK).toBe(3);
    expect(cfg.semanticTtlSec).toBe(3600);
    expect(cfg.savedUsdPer1kTokens).toBe(0);
  });

  it("explicitly set invalid numeric values throw naming the key and value", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["PORT", "0", /^PORT must be a positive number; got "0"$/],
      ["PORT", "not-a-port", /^PORT must be a positive number; got "not-a-port"$/],
      ["UPSTREAM_TIMEOUT_MS", "abc", /^UPSTREAM_TIMEOUT_MS must be a positive number; got "abc"$/],
      ["CACHE_TTL_S", "0", /^CACHE_TTL_S must be a positive number; got "0"$/],
      ["CACHE_TTL_S", "-5", /^CACHE_TTL_S must be a positive number; got "-5"$/],
      ["SEMANTIC_TTL_S", "-1", /^SEMANTIC_TTL_S must be a positive number; got "-1"$/],
      ["SEMANTIC_TOP_K", "zero", /^SEMANTIC_TOP_K must be a positive number; got "zero"$/],
      ["SEMANTIC_THRESHOLD", "1", /^SEMANTIC_THRESHOLD must be a number in \(0, 1\); got "1"$/],
      ["SEMANTIC_THRESHOLD", "0", /^SEMANTIC_THRESHOLD must be a number in \(0, 1\); got "0"$/],
      ["SEMANTIC_THRESHOLD", "1.5", /^SEMANTIC_THRESHOLD must be a number in \(0, 1\); got "1\.5"$/],
      ["SAVED_USD_PER_1K_TOKENS", "-3", /^SAVED_USD_PER_1K_TOKENS must be a non-negative number; got "-3"$/],
    ];
    for (const [key, value, message] of cases) {
      expect(() => load({ [key]: value })).toThrow(message);
    }
  });

  it("valid numeric values pass through unchanged", () => {
    const cfg = load({
      PORT: "8080",
      UPSTREAM_TIMEOUT_MS: "1500",
      CACHE_TTL_S: "60",
      SEMANTIC_THRESHOLD: " 0.5 ",
      SEMANTIC_TOP_K: "7",
      SEMANTIC_TTL_S: "120",
      SAVED_USD_PER_1K_TOKENS: "0",
    });
    expect(cfg.port).toBe(8080);
    expect(cfg.upstreamTimeoutMs).toBe(1500);
    expect(cfg.cacheTtlSec).toBe(60);
    expect(cfg.semanticThreshold).toBe(0.5);
    expect(cfg.semanticTopK).toBe(7);
    expect(cfg.semanticTtlSec).toBe(120);
    expect(cfg.savedUsdPer1kTokens).toBe(0);
  });

  it("fractional non-unit threshold values throw; in-range values parse", () => {
    expect(() => load({ SEMANTIC_THRESHOLD: "0.999" })).not.toThrow();
    expect(load({ SEMANTIC_THRESHOLD: "0.999" }).semanticThreshold).toBe(0.999);
    expect(() => load({ SEMANTIC_THRESHOLD: "1.0" })).toThrow(/SEMANTIC_THRESHOLD must be a number in \(0, 1\)/);
    expect(() => load({ SEMANTIC_THRESHOLD: "NaN" })).toThrow(/SEMANTIC_THRESHOLD must be a number in \(0, 1\)/);
    expect(() => load({ SAVED_USD_PER_1K_TOKENS: "NaN" })).toThrow(/SAVED_USD_PER_1K_TOKENS must be a non-negative number/);
    expect(load({ SAVED_USD_PER_1K_TOKENS: "0.25" }).savedUsdPer1kTokens).toBe(0.25);
  });
});

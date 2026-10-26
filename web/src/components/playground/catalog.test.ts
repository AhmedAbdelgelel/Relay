import { describe, expect, it } from "vitest";
import { DEFAULTS, freeModelFailureHint, isFreeModel, PROVIDERS } from "@/components/playground/catalog";

describe("playground free-model catalog", () => {
  it("only bundles verified working $0 ids and drops the retired nvidia ids", () => {
    const models = PROVIDERS.openrouter.models;
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.every(isFreeModel)).toBe(true);
    expect(models[0]).toBe("cohere/north-mini-code:free");
    expect(models).toContain("xingchen-agi/xing4.0-29b-a4b:free");
    expect(models.some((m) => m.includes("nvidia/"))).toBe(false);
  });

  it("defaults to cacheable (non-stream) requests so the simple UI can show the layers", () => {
    expect(DEFAULTS.stream).toBe(false);
    expect(DEFAULTS.model).toBe("mock");
  });
});

describe("freeModelFailureHint", () => {
  it("explains dead/rate-limited free upstreams and suggests verified models", () => {
    const dead = freeModelFailureHint("nvidia/nemotron-3-super-120b-a12b:free", "provider_not_found");
    expect(dead).toContain("unavailable upstream");
    expect(dead).toContain("cohere/north-mini-code:free");
    const limited = freeModelFailureHint("google/gemma-4-31b-it:free", "provider_rate_limited");
    expect(limited).toContain("rate-limited upstream");
  });

  it("stays out of the way for paid models and unrelated gateway errors", () => {
    expect(freeModelFailureHint("gpt-5", "provider_not_found")).toBeNull();
    expect(freeModelFailureHint("cohere/north-mini-code:free", "invalid_request")).toBeNull();
    expect(freeModelFailureHint("cohere/north-mini-code:free", null)).toBeNull();
  });
});

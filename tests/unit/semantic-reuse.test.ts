import { describe, expect, it } from "vitest";
import { isReusableSemantic, systemFingerprint, POLICY_VERSION } from "../../src/policy/reuse.js";
import type { SemanticHit } from "../../src/cache/SemanticCacheStore.js";

function hit(over: Partial<SemanticHit> = {}): SemanticHit {
  return {
    id: "h1",
    promptText: "hello",
    content: "hi there",
    temperature: 0.7,
    maxTokens: 512,
    model: "gemini-3.6-flash",
    provider: "gemini",
    tenant: "default",
    systemFingerprint: systemFingerprint(req()),
    policyVersion: POLICY_VERSION,
    similarity: 0.95,
    ...over,
  };
}

function req(over: Record<string, unknown> = {}) {
  return {
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.7,
    max_tokens: 512,
    stream: false,
    ...over,
  } as any;
}

describe("isReusableSemantic (Similarity != Equivalence != Reusability)", () => {
  it("reuses an exact-identity candidate above threshold", () => {
    const d = isReusableSemantic(req(), hit(), { provider: "gemini", threshold: 0.92, tenant: "default" });
    expect(d).toEqual({ reusable: true, reason: "ok" });
  });

  it("rejects provider mismatch even at similarity 1.0", () => {
    const d = isReusableSemantic(req(), hit({ provider: "openai", similarity: 1 }), {
      provider: "gemini",
      threshold: 0.92,
      tenant: "default",
    });
    expect(d.reusable).toBe(false);
    expect(d.reason).toBe("provider-mismatch");
  });

  it("rejects model mismatch (same vector space, different model)", () => {
    const d = isReusableSemantic(req(), hit({ model: "gpt-5" }), { provider: "gemini", threshold: 0.5, tenant: "default" });
    expect(d.reason).toBe("model-mismatch");
  });

  it("rejects temperature mismatch (sampling differs)", () => {
    const d = isReusableSemantic(req({ temperature: 0.2 }), hit({ temperature: 0.7 }), {
      provider: "gemini",
      threshold: 0.5,
      tenant: "default",
    });
    expect(d.reason).toBe("temperature-mismatch");
  });

  it("defaults missing temperature to 1.0 on both sides", () => {
    const r = req();
    delete (r as any).temperature;
    const d = isReusableSemantic(r, hit({ temperature: 1.0 }), { provider: "gemini", threshold: 0.5, tenant: "default" });
    expect(d.reusable).toBe(true);
  });

  it("rejects max_tokens mismatch", () => {
    const d = isReusableSemantic(req({ max_tokens: 256 }), hit({ maxTokens: 512 }), {
      provider: "gemini",
      threshold: 0.5,
      tenant: "default",
    });
    expect(d.reason).toBe("max-tokens-mismatch");
  });

  it("treats undefined max_tokens symmetrically", () => {
    const r = req();
    delete (r as any).max_tokens;
    const d = isReusableSemantic(r, hit({ maxTokens: undefined }), { provider: "gemini", threshold: 0.5, tenant: "default" });
    expect(d.reusable).toBe(true);
  });

  it("rejects below-threshold similarity", () => {
    const d = isReusableSemantic(req(), hit({ similarity: 0.91 }), {
      provider: "gemini",
      threshold: 0.92,
      tenant: "default",
    });
    expect(d.reason).toBe("below-threshold");
  });

  it("accepts similarity exactly at threshold (>=)", () => {
    const d = isReusableSemantic(req(), hit({ similarity: 0.92 }), {
      provider: "gemini",
      threshold: 0.92,
      tenant: "default",
    });
    expect(d.reusable).toBe(true);
  });

  it("rejects empty content (nothing safe to reuse)", () => {
    for (const content of ["", "   "]) {
      const d = isReusableSemantic(req(), hit({ content }), { provider: "gemini", threshold: 0, tenant: "default" });
      expect(d.reason).toBe("empty-content");
    }
  });

  it("trims model identity before comparing", () => {
    const r = req({ model: "  gemini-3.6-flash  " });
    const d = isReusableSemantic(r, hit(), { provider: "gemini", threshold: 0.5, tenant: "default" });
    expect(d.reusable).toBe(true);
  });

  it("rejects tenant mismatch even at similarity 1.0", () => {
    const d = isReusableSemantic(req(), hit({ similarity: 1 }), {
      provider: "gemini", threshold: 0.92, tenant: "other",
    });
    expect(d).toEqual({ reusable: false, reason: "tenant-mismatch" });
  });

  it("rejects a changed system prompt with the exact reason", () => {
    const r = req({ messages: [{ role: "system", content: "sys-B" }, { role: "user", content: "hello" }] });
    const storedFp = systemFingerprint(req({ messages: [{ role: "system", content: "sys-A" }, { role: "user", content: "hello" }] }));
    expect(storedFp).not.toBe(systemFingerprint(r));
    const d = isReusableSemantic(r, hit({ systemFingerprint: storedFp, similarity: 1 }), {
      provider: "gemini", threshold: 0.92, tenant: "default",
    });
    expect(d).toEqual({ reusable: false, reason: "system-fingerprint-mismatch" });
  });

  it("reuses when the system fingerprint matches", () => {
    const sys = [{ role: "system", content: "sys-A" }, { role: "user", content: "hello" }];
    const r = req({ messages: sys });
    const d = isReusableSemantic(r, hit({ systemFingerprint: systemFingerprint(req({ messages: sys })) }), {
      provider: "gemini", threshold: 0.92, tenant: "default",
    });
    expect(d).toEqual({ reusable: true, reason: "ok" });
  });

  it("skips the fingerprint check for legacy rows (NULL)", () => {
    const d = isReusableSemantic(req(), hit({ systemFingerprint: null }), {
      provider: "gemini", threshold: 0.92, tenant: "default",
    });
    expect(d).toEqual({ reusable: true, reason: "ok" });
  });

  it("rejects entries admitted under an older policy version", () => {
    const d = isReusableSemantic(req(), hit({ policyVersion: POLICY_VERSION - 1 }), {
      provider: "gemini", threshold: 0.92, tenant: "default",
    });
    expect(d).toEqual({ reusable: false, reason: "policy-version-mismatch" });
  });

  it("skips the version check for legacy rows (NULL)", () => {
    const d = isReusableSemantic(req(), hit({ policyVersion: null }), {
      provider: "gemini", threshold: 0.92, tenant: "default",
    });
    expect(d).toEqual({ reusable: true, reason: "ok" });
  });
});

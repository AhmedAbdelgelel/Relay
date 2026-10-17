// @vitest-environment node
/**
 * Canonical parity — the money test.
 *
 * The browser's `canonicalizePayload`/`sha256Hex`/`exactCacheKey` must produce
 * BYTE-IDENTICAL canonical strings, sha256 hashes and cache keys to the
 * gateway's real `src/domain/normalize.ts` for the same request. If this file
 * ever drifts from the server, the browser-side cache-key verification
 * (Metrics card "browser sha256 matches x-cache-hash") becomes a lie.
 *
 * Runs in the node environment: `node:crypto` and `crypto.subtle` are both
 * needed for a real sha256 comparison.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildExactCacheKey } from "../../../src/domain/normalize";
import { canonicalizePayload, exactCacheKey, sha256Hex } from "@/lib/canonical";
import type { ChatPayload } from "@/lib/types";

const PROVIDER = "mock";

/** Assert app canonical/hash/key parity against the gateway for one payload. */
async function assertParity(payload: ChatPayload): Promise<void> {
  const gateway = buildExactCacheKey(PROVIDER, payload);
  const canonical = canonicalizePayload(payload);

  expect(canonical).toBe(gateway.canonical);
  expect(await sha256Hex(canonical)).toBe(gateway.hash);
  expect(exactCacheKey(PROVIDER, gateway.hash)).toBe(gateway.key);
  expect(gateway.key).toBe(`llm:exact:v1:${PROVIDER}:${gateway.hash}`);
}

const BASE: ChatPayload = {
  model: "gpt-5",
  messages: [{ role: "user", content: "Hello world" }],
  temperature: 0.7,
  stream: false,
};

describe("canonical parity with the gateway", () => {
  it("matches the gateway for a plain ASCII prompt", async () => {
    const canonical = canonicalizePayload(BASE);
    // Byte anchor independent of both implementations: node's own sha256.
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(
      await sha256Hex(canonical),
    );
    await assertParity(BASE);
  });

  it("matches the gateway after whitespace noise is trimmed", async () => {
    const noisy: ChatPayload = {
      model: "  gpt-5  ",
      messages: [
        { role: "system", content: "  Be terse.\t" },
        { role: "user", content: "  Hello \n world  " },
      ],
      temperature: 0.7,
      stream: false,
    };
    const clean: ChatPayload = {
      model: "gpt-5",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hello \n world" },
      ],
      temperature: 0.7,
      stream: false,
    };
    expect(canonicalizePayload(noisy)).toBe(canonicalizePayload(clean));
    await assertParity(noisy);
    await assertParity(clean);
  });

  it("matches the gateway for reordered keys and unknown extra fields", async () => {
    const reordered = {
      stream: true,
      unknownField: { nested: [1, 2, 3] },
      messages: [{ content: "Hello world", role: "user" }],
      temperature: 0.7,
      model: "gpt-5",
    } as ChatPayload;
    expect(canonicalizePayload(reordered)).toBe(canonicalizePayload(BASE));
    await assertParity(reordered);
  });

  it("matches the gateway for unicode content", async () => {
    const unicode: ChatPayload = {
      model: "gemini-3.6-flash",
      messages: [
        { role: "user", content: "Привет, 世界! 🚀 café — ¿qué tal? \u0000 \u00e9" },
        { role: "assistant", content: "答案：naïve façade 日本語" },
      ],
      temperature: 0.25,
      stream: false,
    };
    await assertParity(unicode);
  });

  it("treats a missing temperature as 1.0 on both sides", async () => {
    const missing = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Hello world" }],
      stream: false,
    } as ChatPayload;
    const explicit: ChatPayload = { ...BASE, temperature: 1.0 };

    expect(canonicalizePayload(missing)).toBe(canonicalizePayload(explicit));
    await assertParity(missing);
    await assertParity(explicit);
  });

  it("keeps 0.7 and the 1.0 default distinct", () => {
    expect(canonicalizePayload(BASE)).not.toBe(
      canonicalizePayload({ ...BASE, temperature: 1.0 }),
    );
  });

  it("includes max_tokens when provided and omits it when absent", async () => {
    const withMax: ChatPayload = { ...BASE, max_tokens: 512 };
    const withoutMax: ChatPayload = { ...BASE };
    delete withoutMax.max_tokens;

    expect(canonicalizePayload(withMax)).not.toBe(canonicalizePayload(withoutMax));
    expect(canonicalizePayload(withMax)).toContain('"max_tokens":512');
    expect(canonicalizePayload(withoutMax)).not.toContain("max_tokens");

    await assertParity(withMax);
    await assertParity(withoutMax);
  });

  it.each([
    ["plain ASCII prompt", BASE],
    ["max_tokens set", { ...BASE, max_tokens: 512 }],
    ["stream flag set", { ...BASE, stream: true }],
    ["multi-message system + user", {
      model: "claude-4-sonnet",
      messages: [
        { role: "system", content: "Summarize." },
        { role: "user", content: "Once upon a time." },
      ],
      temperature: 0.0,
      stream: true,
    } satisfies ChatPayload],
  ])("hash and key parity: %s", async (_name, payload) => {
    await assertParity(payload);
  });
});

describe("exactCacheKey", () => {
  it("formats llm:exact:v1:<provider>:<hash>", () => {
    expect(exactCacheKey("openai", "abc123")).toBe("llm:exact:v1:openai:abc123");
  });
});

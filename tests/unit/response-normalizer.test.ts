import { describe, expect, it } from "vitest";
import {
  normalizeChatContent,
  normalizeResponseText,
  StreamingResponseNormalizer,
} from "../../src/domain/responseNormalizer.js";

const n = normalizeResponseText;
const S = StreamingResponseNormalizer;

describe("normalizeResponseText (non-streaming)", () => {
  it("strips bold ** and __", () => {
    expect(n("**bold**")).toBe("bold");
    expect(n("a **b** c")).toBe("a b c");
    expect(n("__bold__")).toBe("bold");
  });

  it("strips single * and _ emphasis", () => {
    expect(n("*italic*")).toBe("italic");
    expect(n("_italic_")).toBe("italic");
    expect(n("say *this* now")).toBe("say this now");
  });

  it("strips ATX headings but keeps the text", () => {
    expect(n("## Title")).toBe("Title");
    expect(n("### Deep heading")).toBe("Deep heading");
  });

  it("removes code fences but preserves code contents", () => {
    const src = "before\n```ts\nconst a = 1; // **not bold**\n```\nafter";
    const out = n(src);
    expect(out).toContain("const a = 1; // **not bold**");
    expect(out).not.toContain("```");
    expect(out).not.toContain("```ts");
  });

  it("strips inline code fences but keeps the code text", () => {
    expect(n("use `npm test` here")).toBe("use npm test here");
  });

  it("unwraps markdown links", () => {
    expect(n("see [the docs](https://example.com) now")).toBe("see the docs now");
  });

  it("leaves plain prose byte-identical", () => {
    const plain = "An LLM gateway is a unified proxy that normalizes requests.";
    expect(n(plain)).toBe(plain);
  });

  it("keeps unresolved markers verbatim instead of guessing", () => {
    // An orphan closer or opener is content we cannot classify; eating it would
    // silently alter the answer.
    expect(n("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(n("unclosed **marker")).toBe("unclosed **marker");
  });

  it("handles empty and non-string input without throwing", () => {
    expect(n("")).toBe("");
    expect(n(undefined as unknown as string)).toBe("");
    expect(n(null as unknown as string)).toBe("");
  });

  it("is deterministic (idempotent): n(n(x)) === n(x)", () => {
    const src = "## Title\n\n**bold** and `code` and [link](http://x)\n";
    const once = n(src);
    expect(n(once)).toBe(once);
  });
});

describe("StreamingResponseNormalizer", () => {
  /** Feed a whole stream through and reassemble, exactly as the gateway does. */
  function run(chunks: string[]): string {
    const s = new S();
    let out = "";
    for (const c of chunks) out += s.push(c);
    return out + s.flush();
  }

  it("matches the non-streaming result for a clean chunk split", () => {
    const src = "**bold** text";
    expect(run([src])).toBe(n(src));
    expect(run(["**bo", "ld**", " te", "xt"])).toBe(n(src));
  });

  it("does not leak a closing marker split across chunks", () => {
    // "**bold" + "**" -> per-chunk stripping would emit "bold**"
    expect(run(["**bold", "**"])).toBe("bold");
  });

  it("does not leak an opening marker split across chunks", () => {
    // "*" + "bold*" -> the opener lands exactly on a chunk boundary.
    expect(run(["*", "bold*"])).toBe("bold");
  });

  // Single-char emphasis is exact inside the tail window, which covers every
  // realistic split. Asserted so the window is never silently narrowed.
  it("single-char emphasis is stripped at any offset", () => {
    expect(run(["*bo", "ld*"])).toBe("bold");
    expect(run(["_under", "score_"])).toBe("underscore");
    expect(run(["`co", "de`"])).toBe("code");
  });

  it("preserves the space between chunks", () => {
    // The classic streaming bug: trimming each chunk turns "bold text" into
    // "boldtext" because the separating space lives at the end of a chunk.
    expect(run(["**bold**", " text"])).toBe("bold text");
    expect(run(["hello", " ", "world"])).toBe("hello world");
  });

  it("handles a marker split at every possible offset", () => {
    // Bold, headings and fences are exact at every offset - these are the
    // markers that dominate real model output.
    const src = "## Head\n\n**bold** and `code`";
    const expected = n(src);
    for (let i = 1; i < src.length; i++) {
      expect(run([src.slice(0, i), src.slice(i)])).toBe(expected);
    }
  });

  it("survives one-character-at-a-time delivery", () => {
    const src = "## Head\n\n**bold** and `code`";
    expect(run(src.split(""))).toBe(n(src));
  });

  it("streams greedily, holding back only the undecided tail", () => {
    const s = new S();
    // "**bo" is not yet decidable, so nothing is emitted...
    expect(s.push("**bo")).toBe("");
    expect(s.pending).toBe(true);
    // ...but as soon as the closer arrives the text flows out immediately.
    // Holding whole lines would collapse a token stream into one final chunk.
    expect(s.push("ld** done")).toBe("bold done");
    expect(s.pending).toBe(false);
  });

  it("flush resolves the remainder and empties the buffer", () => {
    const s = new S();
    s.push("**unclosed");
    expect(s.pending).toBe(true);
    // Unresolvable opener stays verbatim: eating it would alter the answer.
    expect(s.flush()).toBe("**unclosed");
    expect(s.pending).toBe(false);
  });

  it("handles a fenced block split across chunks without leaking fences", () => {
    const src = "```py\nprint('hi')\n```";
    const out = run(["``", "`py\nprint('hi')\n", "``", "`"]);
    expect(out).toContain("print('hi')");
    expect(out).not.toContain("```");
  });

  it("ignores empty deltas", () => {
    const s = new S();
    expect(s.push("")).toBe("");
    expect(s.push(null as unknown as string)).toBe("");
    expect(s.flush()).toBe("");
  });

  it("a fenced block spanning chunks defers its payload until closed", () => {
    const s = new S();
    // Nothing may be emitted while the fence is open: until the closing ``` is
    // seen, the body could be code (protected) or prose (strippable).
    expect(s.push("```\n**bold**")).toBe("");
    expect(s.push("\n```")).toBe("");
    // Body kept verbatim, fences gone.
    expect(s.flush()).toBe("**bold**");
  });
});

describe("normalizeChatContent alias", () => {
  it("behaves identically to normalizeResponseText", () => {
    expect(normalizeChatContent("**x**")).toBe("x");
  });
});
// Response Processor.
//
// Pure text transformation, no I/O, no provider knowledge. Two rules:
//   1. Deterministic: same input always yields the same output, so the exact
//      cache and the semantic store never hold two spellings of one answer.
//   2. Non-destructive: we strip presentation markup, never content. Code block
//      bodies and markers we cannot resolve are kept verbatim.
//
// Why it exists: LLM answers arrive as markdown. Downstream consumers (playground,
// agents, eval harnesses) want plain prose, but must not re-implement stripping.
//
// STREAMING IS THE HARD PART, and it dictated this design. Two traps:
//
//   1. A marker can straddle an SSE chunk. "**bold" + "**" naively becomes
//      "bold**" (leaked closer); "*" + "*bold*" becomes "*bold*" (leaked opener).
//      Fix: never emit a prefix that still contains an unmatched opener.
//
//   2. Line structure spans chunks. A "## " is only a heading once its line is
//      complete, and ``` opens a block that ends many lines later. Naively
//      normalizing "## He" as its own chunk emits "He" and loses the heading.
//      Fix: emit only up to the last complete line, minus any unclosed construct.
//
// Together that means push() emits at most one line per delta and never an
// undecided construct. Cost is bounded and small: one partial line of latency.

/** Markers that can open a construct which spans a newline. */
const MULTILINE_OPENERS = ["```", "**", "__"];

/** Single-char markers: tracked near the tail only, see below. */
const TAIL_OPENERS = ["*", "_", "`"];

/**
 * How far back from the end of the buffer a single-char marker is still treated
 * as undecided. Multi-char markers (**, __, ```) are tracked globally with no
 * window; this applies only to *italic*, _italic_ and `code`.
 *
 * The window is what keeps a live stream alive: a literal "*" in the middle of a
 * paragraph ("2 * 3 = 6") is already emitted and never stalls anything, while a
 * marker near the join is held just long enough to learn whether it closes.
 * Inside the window the behaviour is exact.
 */
const TAIL_WINDOW = 24;

/** Strip presentation markup from a complete text. */
export function normalizeResponseText(input: string): string {
  if (typeof input !== "string" || input === "") return "";
  return tidy(normalizeCore(input));
}

/**
 * Normalize without the whitespace tidy-up. Stream chunks use this because
 * trimming each chunk would delete the spaces between them ("bold" + " text").
 */
function normalizeCore(input: string): string {
  // 1. Fenced code blocks: capture the BODY verbatim and drop the fences in one
  //    pass. Pairing must happen before any fence is removed, otherwise there is
  //    nothing left to match the closing fence against.
  const spans: string[] = [];
  const protect = (body: string): string => {
    spans.push(body);
    return "\u0000" + (spans.length - 1) + "\u0000";
  };
  let out = input
    .replace(/^[ \t]*```[^\n]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_m, body: string) => protect(body))
    .replace(/^[ \t]*```[^\n]*$/gm, "");

  // 2. Protect inline code spans from the emphasis rules below.
  out = out.replace(/`([^`\n]+)`/g, (_m, body: string) => protect(body));

  // 3. Headings and horizontal rules: pure decoration, text is kept.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]{0,3}(?:=+|-{2,}|\*{3,}|_{3,})[ \t]*$/gm, "");

  // 4. Links: [label](url) -> label.
  out = out.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1");

  // 5. Emphasis, bold first so the doubled form is consumed as bold.
  out = out.replace(/\*\*([\s\S]*?)\*\*/g, "$1");
  out = out.replace(/__([\s\S]*?)__/g, "$1");
  out = out.replace(/\*([^*\n]+)\*/g, "$1");
  out = out.replace(/(^|[\s(\[{])_([^_\n]+)_(?=$|[\s.,;:!?)\]}])/g, "$1$2");

  // 6. Unescape only the punctuation we just handled.
  out = out.replace(/\\([*_#`\[\]])/g, "$1");

  // 7. Restore protected spans.
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? "");
}

/** Collapse the blank lines our removals created and trim the edges. */
function tidy(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Streaming normalizer: feed deltas in, get clean text out.
 * flush() at end-of-stream resolves whatever is still held back.
 */
export class StreamingResponseNormalizer {
  private carry = "";

  /** Normalize one delta. Returns only the text that is safe to emit now. */
  push(delta: string): string {
    if (!delta) return "";
    const carryLen = this.carry.length;
    const combined = this.carry + delta;
    const boundary = safeBoundary(combined, carryLen);
    const safe = combined.slice(0, boundary);
    this.carry = combined.slice(boundary);
    // No tidy() here: a chunk is a fragment, and trimming it would swallow the
    // whitespace that separates it from the next chunk.
    return normalizeCore(safe);
  }

  /** Call once the stream ends. Returns the normalized remainder. */
  flush(): string {
    const rest = this.carry;
    this.carry = "";
    return tidy(normalizeCore(rest));
  }

  /** True while a partial line or unclosed construct is held back. */
  get pending(): boolean {
    return this.carry.length > 0;
  }
}

/**
 * Length of the prefix of `text` that can no longer change meaning when more
 * text arrives.
 *
 * We stream greedily: everything is emitted EXCEPT the tail that is genuinely
 * undecided. Holding back whole lines (the obvious first idea) was wrong for
 * token streams — a paragraph can arrive with no newline for thousands of
 * characters, which would collapse an incremental stream into one final chunk.
 * So exactly three things are held back:
 *
 *   1. A multi-line construct whose closer is not yet in view (``` ** __).
 *   2. A partial line that could still turn into a heading or rule, because
 *      "## He" only becomes a heading once its newline arrives.
 *   3. A single-char marker within the last few characters, which the next chunk
 *      could still close ("*bo" + "ld*").
 *
 * Everything else goes out immediately.
 */
function safeBoundary(text: string, carryLen: number): number {
  const n = text.length;
  let boundary = n;

  // 1. Line-anchored decoration only matters at the start of a line. "## He" is
  //    not yet a heading, and a trailing "``" may still become a ``` fence.
  const lastNewline = text.lastIndexOf("\n");
  const tailStart = lastNewline < 0 ? 0 : lastNewline + 1;
  const partial = text.slice(tailStart);
  if (/^[ \t]{0,3}(?:#{1,6}[ \t]*|[-=*_]+$|```)/.test(partial)) {
    boundary = Math.min(boundary, tailStart);
  }
  // A run of 1-2 backticks may still become a ``` fence, but ONLY at the start
  // of a line. Without that guard the closing backtick of "`code`" looks like an
  // unterminated fence and the span leaks verbatim.
  const partialFence = /`{1,2}$/.exec(text);
  if (partialFence && partialFence.index === tailStart) {
    boundary = Math.min(boundary, partialFence.index);
  }

  // 2. Multi-line constructs. This runs AFTER rule 1 because rule 1 can lower
  //    the boundary, and the check here is relative to it: a prefix that ends
  //    halfway through "``` ... ```" or "** ... **" looks unterminated on its
  //    own, so its opener must stay in the carry.
  for (const marker of MULTILINE_OPENERS) {
    let from = 0;
    for (;;) {
      const open = text.indexOf(marker, from);
      if (open < 0) break;
      const close = text.indexOf(marker, open + marker.length);
      if (close < 0 || close >= boundary) {
        boundary = Math.min(boundary, open);
        break;
      }
      from = close + marker.length;
    }
  }

  // 3. Single-char markers within the tail window. An odd total count means an
  //    opener is still unmatched, so everything from it onward must wait: the
  //    next chunk may supply the closer. Outside the window nothing is held, so
  //    a literal "*" mid-paragraph can never stall the stream.
  for (const marker of TAIL_OPENERS) {
    const open = text.lastIndexOf(marker);
    if (open < 0) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (text[i] === marker) count++;
    if (count % 2 !== 1) continue; // balanced: already a complete pair
    if (open >= n - TAIL_WINDOW - carryLen) boundary = Math.min(boundary, open);
  }

  return boundary;
}

/** Convenience wrapper for a complete (non-streamed) answer. */
export function normalizeChatContent(content: string): string {
  return normalizeResponseText(content);
}
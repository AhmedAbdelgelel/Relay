
const MULTILINE_OPENERS = ["```", "**", "__"];

const TAIL_OPENERS = ["*", "_", "`"];

const TAIL_WINDOW = 24;

export function normalizeResponseText(input: string): string {
  if (typeof input !== "string" || input === "") return "";
  return tidy(normalizeCore(input));
}

function normalizeCore(input: string): string {
  const spans: string[] = [];
  const protect = (body: string): string => {
    spans.push(body);
    return "\u0000" + (spans.length - 1) + "\u0000";
  };
  let out = input
    .replace(/^[ \t]*```[^\n]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_m, body: string) => protect(body))
    .replace(/^[ \t]*```[^\n]*$/gm, "");

  out = out.replace(/`([^`\n]+)`/g, (_m, body: string) => protect(body));

  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]{0,3}(?:=+|-{2,}|\*{3,}|_{3,})[ \t]*$/gm, "");

  out = out.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1");

  out = out.replace(/\*\*([\s\S]*?)\*\*/g, "$1");
  out = out.replace(/__([\s\S]*?)__/g, "$1");
  out = out.replace(/\*([^*\n]+)\*/g, "$1");
  out = out.replace(/(^|[\s(\[{])_([^_\n]+)_(?=$|[\s.,;:!?)\]}])/g, "$1$2");

  out = out.replace(/\\([*_#`\[\]])/g, "$1");

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? "");
}

function tidy(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export class StreamingResponseNormalizer {
  private carry = "";

  push(delta: string): string {
    if (!delta) return "";
    const carryLen = this.carry.length;
    const combined = this.carry + delta;
    const boundary = safeBoundary(combined, carryLen);
    const safe = combined.slice(0, boundary);
    this.carry = combined.slice(boundary);
    return normalizeCore(safe);
  }

  flush(): string {
    const rest = this.carry;
    this.carry = "";
    return tidy(normalizeCore(rest));
  }

  get pending(): boolean {
    return this.carry.length > 0;
  }
}

function safeBoundary(text: string, carryLen: number): number {
  const n = text.length;
  let boundary = n;

  const lastNewline = text.lastIndexOf("\n");
  const tailStart = lastNewline < 0 ? 0 : lastNewline + 1;
  const partial = text.slice(tailStart);
  if (/^[ \t]{0,3}(?:#{1,6}[ \t]*|[-=*_]+$|```)/.test(partial)) {
    boundary = Math.min(boundary, tailStart);
  }
  const partialFence = /`{1,2}$/.exec(text);
  if (partialFence && partialFence.index === tailStart) {
    boundary = Math.min(boundary, partialFence.index);
  }

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

  for (const marker of TAIL_OPENERS) {
    const open = text.lastIndexOf(marker);
    if (open < 0) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (text[i] === marker) count++;
    if (count % 2 !== 1) continue;
    if (open >= n - TAIL_WINDOW - carryLen) boundary = Math.min(boundary, open);
  }

  return boundary;
}

export function normalizeChatContent(content: string): string {
  return normalizeResponseText(content);
}
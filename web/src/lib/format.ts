/**
 * Display formatting helpers. Everything is deterministic across SSR/CSR
 * (`en-US` is always passed explicitly) so hydration never drifts.
 */

/** Client price table mirroring legacy public/js/state.js (USD per 1M tokens). */
export const COST_PER_1M: Record<string, { in: number; out: number }> = {
  "gemini-3.6-flash": { in: 0.075, out: 0.3 },
  "gemini-3.5-flash-lite": { in: 0.0375, out: 0.15 },
  "gpt-5": { in: 1.25, out: 10.0 },
  "gpt-5-mini": { in: 0.25, out: 2.0 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "claude-4": { in: 3.0, out: 15.0 },
  "claude-4-sonnet": { in: 1.5, out: 7.5 },
  "claude-3.7-haiku": { in: 0.25, out: 1.25 },
};

const DEFAULT_PRICE = { in: 0.5, out: 1.5 };

export function estimateCost(
  model: string,
  tokens: { prompt?: number; completion?: number } | null | undefined,
): number {
  if (!tokens) return 0;
  const rate = COST_PER_1M[model] ?? DEFAULT_PRICE;
  return ((tokens.prompt ?? 0) / 1e6) * rate.in + ((tokens.completion ?? 0) / 1e6) * rate.out;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** ms precision under 1000ms ("5ms"), one decimal second above ("1.2s"). */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

export function formatTokens(n: number | null | undefined): string {
  return formatCount(n);
}

/** `part / whole` as a percentage in [0, 100]; 0 when whole is 0. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** "12.34%" — two decimals like the legacy fmtRate. */
export function formatRate(p: number): string {
  return `${(Math.round(p * 100) / 100).toFixed(2)}%`;
}

/** Rough fallback when the provider reports no usage: ~4 chars per token. */
export function estimateTokens(text: string | null | undefined): number {
  const t = String(text ?? "");
  return t.trim() ? Math.max(1, Math.round(t.length / 4)) : 0;
}

/** "7h33m58.8s" → 27238.8, "45s" → 45, "retryDelay: 45s" → 45. */
export function parseWaitSeconds(raw: string): number | null {
  const hms = raw.match(/(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?\s*([\d.]+)\s*s/i);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + parseFloat(hms[3]);
  const hm = raw.match(/(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?/i);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
  const ms = raw.match(/(\d+)\s*m(?:in(?:ute)?s?)?\s*([\d.]+)?\s*s/i);
  if (ms && /retry/i.test(raw)) return Number(ms[1]) * 60 + (ms[2] ? parseFloat(ms[2]) : 0);
  const secs = raw.match(/retry in ([\d.]+)\s*s/i);
  if (secs) return parseFloat(secs[1]);
  const delay = raw.match(/retryDelay"?\s*:?\s*"?(\d+)/i);
  if (delay) return Number(delay[1]);
  // Bare seconds ("45s"): no h/m segment, no retry wording required. The
  // boundary keeps "12m30s" null (its seconds follow a minutes part).
  const bare = raw.match(/(?:^|[^\w.])([\d.]+)\s*s(?![\w])/i);
  if (bare) return parseFloat(bare[1]);
  return null;
}

/** Compact human wait: "45s" / "8m" / "7.5h". */
export function humanWait(totalSeconds: number | null | undefined): string | null {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return null;
  }
  if (totalSeconds < 60) return `${Math.ceil(totalSeconds)}s`;
  if (totalSeconds < 3600) return `${Math.round(totalSeconds / 60)}m`;
  const hrs = totalSeconds / 3600;
  return `${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)}h`;
}

/** Parse a provider quota message and render it as a compact wait string. */
export function formatWait(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const seconds = parseWaitSeconds(raw);
  return seconds === null ? null : humanWait(seconds);
}

/** ISO timestamp → local 24h clock time ("14:03:22"). */
export function timeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-US", { hour12: false });
}

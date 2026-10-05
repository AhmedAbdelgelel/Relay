import { DEFAULTS } from "./config.js";

export function defaultForm() {
  return {
    provider: DEFAULTS.provider,
    model: DEFAULTS.model,
    system: "",
    user: "",
    temperature: DEFAULTS.temperature,
    maxTokens: DEFAULTS.maxTokens,
    stream: true,
  };
}

export function buildPayload(form) {
  const messages = [];
  if (form.system && String(form.system).trim()) {
    messages.push({ role: "system", content: String(form.system).trim() });
  }
  messages.push({ role: "user", content: form.user });
  const payload = {
    model: form.model,
    messages,
    temperature: form.temperature,
    stream: form.stream,
  };
  if (form.maxTokens) payload.max_tokens = form.maxTokens;
  return payload;
}

export function formatTokens(usage) {
  if (!usage) return null;
  return {
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
  };
}

/**
 * Mirror of src/domain/normalize.ts (gateway side): trim model + content,
 * temperature default 1.0, max_tokens omitted when absent, stream excluded,
 * object keys sorted. The sha256 of this string must equal the gateway's
 * x-cache-hash — that equality is what the metrics card verifies (D3).
 */
export function canonicalRequest(payload) {
  const normalized = {
    model: String(payload.model ?? "").trim(),
    messages: (payload.messages || []).map((m) => ({
      role: m.role,
      content: String(m.content ?? "").trim(),
    })),
    temperature: payload.temperature ?? 1.0,
  };
  if (payload.max_tokens !== undefined) normalized.max_tokens = payload.max_tokens;
  return JSON.stringify(sortDeep(normalized));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = sortDeep(value[k]);
    return sorted;
  }
  return value;
}

/** sha256 hex, or null when crypto.subtle is unavailable (insecure context). */
export async function sha256Hex(text) {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** Rough fallback when the provider reports no usage: ~4 chars per token. */
export function estimateTokens(text) {
  const t = String(text || "");
  return t.trim() ? Math.max(1, Math.round(t.length / 4)) : 0;
}

export function estimateUsage(payload, responseText) {
  const prompt = (payload.messages || []).map((m) => m.content).join("\n");
  return { prompt: estimateTokens(prompt), completion: estimateTokens(responseText) };
}

export function tokensPerSecond(usage, latencyMs, ttftMs) {
  if (!usage || !latencyMs) return null;
  const generatingMs = Math.max(latencyMs - (ttftMs || 0), 1);
  return Math.round((usage.completion / generatingMs) * 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

const COST_PER_1M = {
  "gemini-3.6-flash": { in: 0.075, out: 0.3 },
  "gemini-3.5-flash-lite": { in: 0.0375, out: 0.15 },
  "gpt-5": { in: 1.25, out: 10.0 },
  "gpt-5-mini": { in: 0.25, out: 2.0 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "claude-4": { in: 3.0, out: 15.0 },
  "claude-4-sonnet": { in: 1.5, out: 7.5 },
  "claude-3.7-haiku": { in: 0.25, out: 1.25 },
};

export function estimateCost(model, tokens) {
  if (!tokens) return 0;
  const rate = COST_PER_1M[model] || { in: 0.5, out: 1.5 };
  return (tokens.prompt / 1e6) * rate.in + (tokens.completion / 1e6) * rate.out;
}

export function formatCost(usd) {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

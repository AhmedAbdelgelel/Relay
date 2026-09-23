import { DEFAULTS } from "./config.js";

export function defaultForm() {
  return {
    model: DEFAULTS.model,
    user: "",
    temperature: DEFAULTS.temperature,
    maxTokens: DEFAULTS.maxTokens,
    stream: true,
  };
}

export function buildPayload(form) {
  const payload = {
    model: form.model,
    messages: [{ role: "user", content: form.user }],
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

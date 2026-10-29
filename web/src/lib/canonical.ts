import type { ChatPayload, ChatPayloadMessage } from "./types";

/** Inputs for building a playground payload (mirrors legacy defaultForm()). */
export interface BuildPayloadForm {
  model: string;
  system?: string | null;
  user: string;
  /** Sampling is intentionally not surfaced in the simple composer: absent
   *  fields are normalized by the gateway (temperature ?? 1.0, no max_tokens). */
  temperature?: number;
  maxTokens?: number | null;
  stream: boolean;
}

/** Mirror of legacy public/js/state.js buildPayload(). */
export function buildPayload(form: BuildPayloadForm): ChatPayload {
  const messages: ChatPayloadMessage[] = [];
  if (form.system && String(form.system).trim()) {
    messages.push({ role: "system", content: String(form.system).trim() });
  }
  messages.push({ role: "user", content: form.user });
  const payload: ChatPayload = {
    model: form.model,
    messages,
    stream: form.stream,
  };
  if (form.temperature !== undefined) payload.temperature = form.temperature;
  if (form.maxTokens) payload.max_tokens = form.maxTokens;
  return payload;
}

interface NormalizedCanonical {
  model: string;
  messages: ChatPayloadMessage[];
  temperature: number;
  max_tokens?: number;
}

/**
 * Byte-exact mirror of the gateway's src/domain/normalize.ts:
 * trim model + content, temperature ?? 1.0, `stream` excluded, `max_tokens`
 * omitted when absent, all keys sorted. sha256(canonicalizePayload(payload))
 * must equal the gateway's `x-cache-hash`.
 */
export function canonicalizePayload(payload: ChatPayload): string {
  const normalized: NormalizedCanonical = {
    model: String(payload.model ?? "").trim(),
    messages: (payload.messages ?? []).map((m) => ({
      role: m.role,
      content: String(m.content ?? "").trim(),
    })),
    temperature: payload.temperature ?? 1.0,
  };
  if (payload.max_tokens !== undefined) normalized.max_tokens = payload.max_tokens;
  return JSON.stringify(sortDeep(normalized));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortDeep(source[key]);
    return sorted;
  }
  return value;
}

/** sha256 hex of `text`, or null when crypto.subtle is unavailable (SSR/insecure context). */
export async function sha256Hex(text: string): Promise<string | null> {
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

/**
 * The exact-cache key the gateway derives for this hash.
 *
 * Storage keys are tenant-scoped (v2): the gateway prefixes the authenticated
 * tenant before the provider. The control plane does not know the tenant id
 * (it is derived from the gateway key server-side), so `<tenant>` is shown as a
 * placeholder; the hash itself remains tenant-independent.
 */
export function exactCacheKey(provider: string, hash: string, tenant = "<tenant>"): string {
  return `llm:exact:v2:${tenant}:${provider}:${hash}`;
}

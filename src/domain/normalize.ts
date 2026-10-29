import { createHash } from "node:crypto";
import type { ChatRequest } from "./types.js";

export interface NormalizedChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string[];
}

/**
 * Exact-cache key version. Bumped v1 -> v2 when the key became tenant-scoped:
 * v1 entries were global (`llm:exact:v1:<provider>:<hash>`), so reusing them
 * would leak one tenant's answer to another. A v2 lookup can never hit them.
 */
export const EXACT_CACHE_KEY_VERSION = "v2";

export function normalizeChatRequest(req: ChatRequest): NormalizedChatRequest {
  const out: NormalizedChatRequest = {
    model: req.model.trim(),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.trim() })),
    temperature: req.temperature ?? 1.0,
  };
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  // Every supported output-affecting setting is part of the exact identity.
  // `top_p` is emitted only when the client explicitly set it: absent means
  // "upstream default", and an explicit top_p=1 is kept distinct from absent
  // because the gateway cannot verify every OpenAI-compatible upstream's
  // default. `stop` is normalized to its array form because the request schema
  // defines a bare string and a 1-element array as the same request.
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop !== undefined) out.stop = Array.isArray(req.stop) ? req.stop : [req.stop];
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortDeep(obj[k]);
    return sorted;
  }
  return value;
}

export function hashCanonical(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Storage key + canonical hash for the exact cache.
 *
 * `tenant` must be the AUTHENTICATED tenant (`request.auth.tenant`, resolved
 * from the gateway key) — never a client header. It is part of the storage key
 * so two tenants with byte-identical requests get separate entries; the hash
 * itself stays tenant-independent because `x-cache-hash` is the canonical
 * request identity surfaced to clients/browsers.
 *
 * Anonymous lanes never read or write the exact cache, but the streaming path
 * still reports a hash; pass `""` there (the anonymous lane's coalescing key is
 * additionally namespaced by the presented provider key in chat.ts).
 */
export function buildExactCacheKey(
  providerName: string,
  req: ChatRequest,
  tenant: string,
): { key: string; hash: string; canonical: string } {
  const normalized = normalizeChatRequest(req);
  const canonical = canonicalJson(normalized);
  const hash = hashCanonical(canonical);
  return { key: `llm:exact:${EXACT_CACHE_KEY_VERSION}:${tenant}:${providerName}:${hash}`, hash, canonical };
}

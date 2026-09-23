import { createHash } from "node:crypto";
import type { ChatRequest } from "./types.js";

export interface NormalizedChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  max_tokens?: number;
}

export function normalizeChatRequest(req: ChatRequest): NormalizedChatRequest {
  const out: NormalizedChatRequest = {
    model: req.model.trim(),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.trim() })),
    temperature: req.temperature ?? 1.0,
  };
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
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

export function buildExactCacheKey(providerName: string, req: ChatRequest): { key: string; hash: string; canonical: string } {
  const normalized = normalizeChatRequest(req);
  const canonical = canonicalJson(normalized);
  const hash = hashCanonical(canonical);
  return { key: `llm:exact:v1:${providerName}:${hash}`, hash, canonical };
}

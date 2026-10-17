
import { createHash } from "node:crypto";
import type { ChatRequest } from "../domain/types.js";
import type { SemanticHit } from "../cache/SemanticCacheStore.js";

export interface ReuseDecision {
  reusable: boolean;
  reason: string;
}

export const POLICY_VERSION = 1;

export function systemFingerprint(req: ChatRequest): string {
  const systems = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content);
  return createHash("sha256").update(systems.join("\n"), "utf8").digest("hex");
}

export function isReusableSemantic(
  req: ChatRequest,
  candidate: SemanticHit,
  opts: { provider: string; threshold: number; tenant: string },
): ReuseDecision {
  if (candidate.provider !== opts.provider) {
    return { reusable: false, reason: "provider-mismatch" };
  }
  if (candidate.tenant !== opts.tenant) {
    return { reusable: false, reason: "tenant-mismatch" };
  }
  if (candidate.model !== req.model.trim()) {
    return { reusable: false, reason: "model-mismatch" };
  }
  if (candidate.temperature !== (req.temperature ?? 1.0)) {
    return { reusable: false, reason: "temperature-mismatch" };
  }
  const wantMax = req.max_tokens ?? undefined;
  if (candidate.maxTokens !== wantMax) {
    return { reusable: false, reason: "max-tokens-mismatch" };
  }
  if (candidate.systemFingerprint != null && candidate.systemFingerprint !== systemFingerprint(req)) {
    return { reusable: false, reason: "system-fingerprint-mismatch" };
  }
  if (candidate.policyVersion != null && candidate.policyVersion !== POLICY_VERSION) {
    return { reusable: false, reason: "policy-version-mismatch" };
  }
  if (!(candidate.similarity >= opts.threshold)) {
    return { reusable: false, reason: "below-threshold" };
  }
  if (typeof candidate.content !== "string" || candidate.content.trim() === "") {
    return { reusable: false, reason: "empty-content" };
  }
  return { reusable: true, reason: "ok" };
}

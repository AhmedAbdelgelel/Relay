// policy/reuse.ts — L3 gate: Similarity != Equivalence != Reusability.
// The store finds CLOSE vectors; this decides whether reuse is SAFE.
// Pure function, no I/O, fully unit-tested. The store query already filters
// tenant/provider/model/expiry — these checks are defense in depth so a
// caller that bypasses the SQL filters still cannot reuse across boundaries.

import type { ChatRequest } from "../domain/types.js";
import type { SemanticHit } from "../cache/SemanticCacheStore.js";

export interface ReuseDecision {
  reusable: boolean;
  reason: string;
}

export function isReusableSemantic(
  req: ChatRequest,
  candidate: SemanticHit,
  opts: { provider: string; threshold: number },
): ReuseDecision {
  if (candidate.provider !== opts.provider) {
    return { reusable: false, reason: "provider-mismatch" };
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
  if (!(candidate.similarity >= opts.threshold)) {
    return { reusable: false, reason: "below-threshold" };
  }
  if (typeof candidate.content !== "string" || candidate.content.trim() === "") {
    return { reusable: false, reason: "empty-content" };
  }
  return { reusable: true, reason: "ok" };
}

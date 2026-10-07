// providers/capabilities.ts — T8 capability gate (pure, no I/O).
// The HTTP layer calls this BEFORE dispatch: unsupported -> 400
// unsupported_capability with no provider call (INV-1) and no cache touch.
// Note the stream check comes first: streaming is a transport property, so a
// stream:true request to a non-streaming adapter is rejected on
// `streaming` alone (tools/json never factor in).

import type { ChatRequest } from "../domain/types.js";
import type { ProviderCapabilities } from "./ProviderAdapter.js";

export function missingCapabilities(req: ChatRequest, caps: ProviderCapabilities): string[] {
  const missing: string[] = [];
  if (req.stream && !caps.streaming) missing.push("streaming");
  if (!caps.systemMessages && req.messages.some((m) => m.role === "system")) missing.push("systemMessages");
  if (!caps.maxTokens && req.max_tokens !== undefined) missing.push("maxTokens");
  return missing;
}

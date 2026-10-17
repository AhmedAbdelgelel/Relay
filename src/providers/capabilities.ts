
import type { ChatRequest } from "../domain/types.js";
import type { ProviderCapabilities } from "./ProviderAdapter.js";

export function missingCapabilities(req: ChatRequest, caps: ProviderCapabilities): string[] {
  const missing: string[] = [];
  if (req.stream && !caps.streaming) missing.push("streaming");
  if (!caps.systemMessages && req.messages.some((m) => m.role === "system")) missing.push("systemMessages");
  if (!caps.maxTokens && req.max_tokens !== undefined) missing.push("maxTokens");
  return missing;
}

// providers/ProviderAdapter.ts — ISOLATION boundary (Dependency Inversion).
// api/ only depends on this interface, never on fetch/SDK details.

import type { ChatRequest, ChatResponse, TokenUsage } from "../domain/types.js";

/**
 * One streamed piece of a response.
 * - `delta` is the next content text ("" on a usage-only frame).
 * - `usage` is present only on the frame(s) the provider reports token
 *   accounting on (OpenAI sends a final `choices: []` frame when
 *   `stream_options.include_usage` is set). Missing usage is legal: the
 *   gateway must degrade, never invent numbers.
 */
export interface StreamChunk {
  delta: string;
  usage?: TokenUsage;
}

export interface ProviderAdapter {
  readonly name: string;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

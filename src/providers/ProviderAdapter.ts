
import type { ChatRequest, ChatResponse, TokenUsage } from "../domain/types.js";

export interface StreamChunk {
  delta: string;
  usage?: TokenUsage;
}

export interface ProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  json: boolean;
  systemMessages: boolean;
  maxTokens: boolean;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * True when the adapter can authenticate upstream calls it needs to make:
   * adapters built with an empty API key report false, so routes can fail
   * with an actionable 401 instead of dispatchng a keyless request.
   */
  readonly configured: boolean;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}


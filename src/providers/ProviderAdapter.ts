
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
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}


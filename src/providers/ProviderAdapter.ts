// providers/ProviderAdapter.ts — ISOLATION boundary (Dependency Inversion).
// api/ only depends on this interface, never on fetch/SDK details.

import type { ChatRequest, ChatResponse } from "../domain/types.js";

export interface ProviderAdapter {
  readonly name: string;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<string>;
}

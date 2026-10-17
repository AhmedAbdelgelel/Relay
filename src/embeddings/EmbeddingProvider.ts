
import type { ChatRequest } from "../domain/types.js";

export const EMBEDDING_DIM = 768;

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(text: string, signal: AbortSignal): Promise<number[]>;
}

export function promptTextForEmbedding(req: ChatRequest): string {
  return req.messages.map((m) => `${m.role}: ${m.content.trim()}`).join("\n");
}

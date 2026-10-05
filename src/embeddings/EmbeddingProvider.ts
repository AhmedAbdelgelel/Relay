// embeddings/EmbeddingProvider.ts — ISOLATION boundary for vector representations.
// api/ and cache/ depend on this interface only, never on fetch/SDK details.
// Model identity (provider/model/temperature) is NOT embedded: it stays a
// hard filter in the store query + reuse policy. Only the message text is
// embedded, so the same vector space is comparable across models.

import type { ChatRequest } from "../domain/types.js";

/** Single embedding dimension. text-embedding-004 and nomic-embed-text are
 * both 768-d; the store schema (vector(768)) and every provider below agree
 * on this constant. Changing it requires a migration. */
export const EMBEDDING_DIM = 768;

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(text: string, signal: AbortSignal): Promise<number[]>;
}

/** Canonical text that gets embedded: role-tagged, trimmed message lines in
 * order. System prompts included — different instructions must embed
 * differently (Similarity != Equivalence, build plan §1). */
export function promptTextForEmbedding(req: ChatRequest): string {
  return req.messages.map((m) => `${m.role}: ${m.content.trim()}`).join("\n");
}

// Port for similarity search over past answers.
// Two adapters: PgVectorStore (real pgvector, production) and
// InMemoryVectorStore (brute-force cosine, zero-setup fallback — the same
// pattern ADR-003 used for Redis, agent/implementation.md Part B Decision Register). Policy/threshold code above this interface
// is backend-agnostic, so swapping stores changes no lookup semantics.

export interface SemanticFilter {
  tenant: string;
  provider: string;
  model: string;
}

export interface SemanticEntry {
  tenant: string;
  provider: string;
  model: string;
  promptHash: string;
  promptText: string;
  temperature: number;
  maxTokens?: number;
  embedding: number[];
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  ttlSeconds: number;
  systemFingerprint: string;
  policyVersion: number;
}

export interface SemanticHit {
  id: string;
  promptText: string;
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  temperature: number;
  maxTokens?: number;
  model: string;
  provider: string;
  tenant: string;
  /** Instruction identity; null = legacy row admitted before fingerprinting (check skipped). */
  systemFingerprint?: string | null;
  /** Policy version at admission; null = legacy row (check skipped). */
  policyVersion?: number | null;
  /** Cosine similarity in [0,1]; higher = closer. */
  similarity: number;
}

export interface SemanticCacheStore {
  readonly name: string;
  findSimilar(
    embedding: number[],
    filter: SemanticFilter,
    opts: { threshold: number; topK: number },
  ): Promise<SemanticHit[]>;
  save(entry: SemanticEntry): Promise<void>;
  /** Best-effort popularity bump for analytics/eviction. Never throws. */
  recordHit(id: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

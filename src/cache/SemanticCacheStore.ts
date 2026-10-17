
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
  systemFingerprint?: string | null;
  policyVersion?: number | null;
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
  recordHit(id: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

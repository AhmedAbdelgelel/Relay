export interface CacheRepository {
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CachedChatResponse {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  cachedAt: string;
}

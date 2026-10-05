import type { CacheRepository } from "./CacheRepository.js";

// Day 12: bounded LRU. Redis handles eviction server-side (maxmemory-policy);
// the in-memory fallback must not grow unbounded in long-running dev/test.
// Default 1000 entries; oldest-inserted evicted first, hits refresh recency.
export class InMemoryCache implements CacheRepository {
  readonly name = "memory";
  private store = new Map<string, { value: string; expiresAt: number }>();
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    const m = opts.maxEntries ?? 1000;
    this.maxEntries = Number.isFinite(m) && m > 0 ? Math.floor(m) : 1000;
  }

  get size(): number {
    return this.store.size;
  }

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Refresh LRU recency without extending TTL.
    this.store.delete(key);
    this.store.set(key, e);
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.store.has(key)) {
      while (this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next();
        if (oldest.done) break;
        this.store.delete(oldest.value);
      }
    } else {
      this.store.delete(key); // re-insert for recency
    }
    this.store.set(key, { value, expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

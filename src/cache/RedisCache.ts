import { Redis } from "ioredis";
import type { CacheRepository } from "./CacheRepository.js";

export interface RedisCacheOpts {
  url: string;
  commandTimeoutMs?: number;
}

export class RedisCache implements CacheRepository {
  readonly name = "redis";
  private client: Redis;

  constructor(opts: RedisCacheOpts) {
    this.client = new Redis(opts.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: opts.commandTimeoutMs ?? 500,
      retryStrategy: (times: number) => (times > 2 ? null : Math.min(times * 100, 500)),
    });
    this.client.on("error", () => undefined);
  }

  private async ensure(): Promise<void> {
    if (this.client.status === "ready" || this.client.status === "connect") return;
    await this.client.connect();
  }

  async get(key: string): Promise<string | null> {
    await this.ensure();
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.ensure();
    await this.client.set(key, value, "EX", Math.max(1, Math.floor(ttlSeconds)));
  }

  async del(key: string): Promise<void> {
    await this.ensure();
    await this.client.del(key);
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensure();
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.client.disconnect();
    } catch {
    }
  }
}

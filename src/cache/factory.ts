import type { GatewayConfig } from "../infrastructure/config.js";
import type { CacheRepository } from "./CacheRepository.js";
import { InMemoryCache } from "./InMemoryCache.js";
import { RedisCache } from "./RedisCache.js";

export function createCacheFromEnv(cfg: GatewayConfig): CacheRepository {
  if (cfg.redisUrl) return new RedisCache({ url: cfg.redisUrl });
  return new InMemoryCache();
}

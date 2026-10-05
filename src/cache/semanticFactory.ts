// cache/semanticFactory.ts — CHOOSING for the semantic layer. Only place with
// `new` on vector stores. memory = zero-setup fallback; pgvector = production
// (fails fast at boot on missing DATABASE_URL / missing extension, so a
// misconfigured store is loud instead of silently never hitting).

import type { GatewayConfig } from "../infrastructure/config.js";
import { InMemoryVectorStore } from "./InMemoryVectorStore.js";
import { createPgClient, migrateSemanticCache, PgVectorStore } from "./PgVectorStore.js";
import type { SemanticCacheStore } from "./SemanticCacheStore.js";

export async function createSemanticStoreFromEnv(cfg: GatewayConfig): Promise<SemanticCacheStore | undefined> {
  if (!cfg.semanticEnabled) return undefined;
  if (cfg.semanticStore === "pgvector") {
    if (!cfg.databaseUrl) {
      throw new Error("DATABASE_URL is required when SEMANTIC_STORE=pgvector");
    }
    const client = createPgClient(cfg.databaseUrl);
    try {
      await migrateSemanticCache(client);
      return new PgVectorStore(client);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }
  return new InMemoryVectorStore();
}

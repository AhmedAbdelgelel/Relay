// Production similarity search on real pgvector.
// SQL uses only standard pgvector surface: vector(n) type, <=> (cosine
// distance), HNSW index with vector_cosine_ops. Verified by contract test on
// the generated SQL + scripts/semantic-smoke.mjs against a live
// pgvector-enabled Postgres (local PG here lacks the extension, ADR-005 in
// agent/implementation.md Part B).
//
// Depends on a minimal SqlClient so tests inject a fake and prod passes a
// node-postgres Pool. Table DDL is embedded below (migrateSemanticCache);
// db/migrations/*.sql are the manual-apply records of the same migrations.

import { Pool } from "pg";
import { EMBEDDING_DIM } from "../embeddings/EmbeddingProvider.js";
import { log } from "../infrastructure/logger.js";
import type {
  SemanticCacheStore,
  SemanticEntry,
  SemanticFilter,
  SemanticHit,
} from "./SemanticCacheStore.js";

export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

interface HitRow {
  id: string;
  prompt_text: string;
  content: string;
  usage_prompt: number | null;
  usage_completion: number | null;
  temperature: number;
  max_tokens: number | null;
  model: string;
  provider: string;
  tenant_id: string;
  system_fingerprint: string | null;
  policy_version: number | null;
  similarity: number;
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PgVectorStore implements SemanticCacheStore {
  readonly name = "pgvector";
  private db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  /** tenant+provider+model isolated, cosine similarity >= threshold, best first. */
  async findSimilar(
    embedding: number[],
    filter: SemanticFilter,
    opts: { threshold: number; topK: number },
  ): Promise<SemanticHit[]> {
    if (embedding.length !== EMBEDDING_DIM) return [];
    const vec = toVectorLiteral(embedding);
    const { rows } = await this.db.query<HitRow>(
      `SELECT id, prompt_text, content, usage_prompt, usage_completion,
              temperature, max_tokens, model, provider, tenant_id,
              system_fingerprint, policy_version,
              1 - (embedding <=> $1::vector) AS similarity
         FROM semantic_cache
        WHERE tenant_id = $2 AND provider = $3 AND model = $4
          AND expires_at > now()
          AND 1 - (embedding <=> $1::vector) >= $5
        ORDER BY embedding <=> $1::vector
        LIMIT $6`,
      [vec, filter.tenant, filter.provider, filter.model, opts.threshold, Math.max(1, opts.topK)],
    );
    return rows.map((r) => ({
      id: String(r.id),
      promptText: r.prompt_text,
      content: r.content,
      usage:
        r.usage_prompt !== null || r.usage_completion !== null
          ? { prompt_tokens: r.usage_prompt ?? 0, completion_tokens: r.usage_completion ?? 0 }
          : undefined,
      temperature: Number(r.temperature),
      maxTokens: r.max_tokens ?? undefined,
      model: r.model,
      provider: r.provider,
      tenant: r.tenant_id,
      systemFingerprint: r.system_fingerprint,
      policyVersion: r.policy_version,
      similarity: Number(r.similarity),
    }));
  }

  async save(entry: SemanticEntry): Promise<void> {
    if (entry.embedding.length !== EMBEDDING_DIM) return;
    await this.db.query(
      `INSERT INTO semantic_cache
         (tenant_id, provider, model, prompt_hash, prompt_text,
          temperature, max_tokens, embedding, content,
          usage_prompt, usage_completion, expires_at,
          system_fingerprint, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11, now() + ($12 || ' seconds')::interval, $13, $14)
       ON CONFLICT (tenant_id, provider, model, prompt_hash)
       DO UPDATE SET prompt_text = EXCLUDED.prompt_text,
                     temperature = EXCLUDED.temperature,
                     max_tokens = EXCLUDED.max_tokens,
                     embedding = EXCLUDED.embedding,
                     content = EXCLUDED.content,
                     usage_prompt = EXCLUDED.usage_prompt,
                     usage_completion = EXCLUDED.usage_completion,
                     expires_at = EXCLUDED.expires_at,
                     system_fingerprint = EXCLUDED.system_fingerprint,
                     policy_version = EXCLUDED.policy_version`,
      [
        entry.tenant,
        entry.provider,
        entry.model,
        entry.promptHash,
        entry.promptText,
        entry.temperature,
        entry.maxTokens ?? null,
        toVectorLiteral(entry.embedding),
        entry.content,
        entry.usage?.prompt_tokens ?? null,
        entry.usage?.completion_tokens ?? null,
        String(Math.max(1, Math.floor(entry.ttlSeconds))),
        entry.systemFingerprint,
        entry.policyVersion,
      ],
    );
  }

  async recordHit(id: string): Promise<void> {
    try {
      await this.db.query(`UPDATE semantic_cache SET hits = hits + 1 WHERE id = $1::uuid`, [id]);
    } catch {
      // Analytics only — never fail a request for a counter.
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.query(`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** node-postgres Pool wrapped as SqlClient. Only place that imports `pg`. */
export function createPgClient(connectionString: string): SqlClient {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 3000 });
  pool.on("error", () => undefined);
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      const res = await pool.query(text, (params ?? []) as unknown[]);
      return { rows: res.rows as T[] };
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
}

const MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS semantic_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  temperature DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  max_tokens INTEGER NULL,
  embedding vector(768) NOT NULL,
  content TEXT NOT NULL,
  usage_prompt INTEGER NULL,
  usage_completion INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
  hits INTEGER NOT NULL DEFAULT 0,
  system_fingerprint TEXT NULL,
  policy_version INTEGER NULL,
  UNIQUE (tenant_id, provider, model, prompt_hash)
)`;

/** Bring a pgvector database to the expected shape. Throws a clear error when  * the `vector` extension is missing (fail fast at boot, ADR-005 in
 * agent/implementation.md Part B). The HNSW
 * index is best-effort: without it lookups still work via sequential scan. */
export async function migrateSemanticCache(db: SqlClient): Promise<void> {
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    throw new Error(
      `pgvector extension missing: ${(err as Error)?.message ?? String(err)}. ` +
        `Install pgvector (or use SEMANTIC_STORE=memory), then restart.`,
    );
  }
  await db.query(MIGRATION_TABLE);
  await db.query(
    `ALTER TABLE semantic_cache
       ADD COLUMN IF NOT EXISTS system_fingerprint TEXT NULL,
       ADD COLUMN IF NOT EXISTS policy_version INTEGER NULL`,
  );
  try {
    await db.query(
      `CREATE INDEX IF NOT EXISTS semantic_cache_embedding_hnsw
         ON semantic_cache USING hnsw (embedding vector_cosine_ops)`,
    );
  } catch (err) {
    log({ msg: "semantic hnsw index skipped (sequential scan)", error: (err as Error)?.message });
  }
}

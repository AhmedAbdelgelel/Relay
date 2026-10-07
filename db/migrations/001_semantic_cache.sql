
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS semantic_cache (
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
  UNIQUE (tenant_id, provider, model, prompt_hash)
);

-- ANN index: exact results not required; recall/latency tradeoff only costs
-- speed, never correctness.
CREATE INDEX IF NOT EXISTS semantic_cache_embedding_hnsw
  ON semantic_cache USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS semantic_cache_scope_idx
  ON semantic_cache (tenant_id, provider, model, expires_at);

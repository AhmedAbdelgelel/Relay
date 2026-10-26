-- 004: identity depth for semantic reuse (system fingerprint + policy version).
-- REFERENCE MIRROR ONLY (see src/cache/PgVectorStore.ts); the runtime ALTER is
-- also applied at boot. Keep in sync with the code.

-- Nullable, no backfill: legacy rows carry NULL and the policy skips those
-- checks for them; newly admitted rows always stamp both columns.
ALTER TABLE semantic_cache
  ADD COLUMN IF NOT EXISTS system_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS policy_version INTEGER NULL;


-- 002: identity depth for semantic reuse (policy-level re-checks).
-- Nullable, no backfill: legacy rows carry NULL and the policy skips those
-- checks for them; newly admitted rows always stamp both columns.
ALTER TABLE semantic_cache
  ADD COLUMN IF NOT EXISTS system_fingerprint TEXT NULL,
  ADD COLUMN IF NOT EXISTS policy_version INTEGER NULL;

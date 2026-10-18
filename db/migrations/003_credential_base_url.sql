
-- 003: per-tenant provider base URLs (bring your own endpoint).
-- The encrypted key column is unchanged; the URL is not a secret, so it is
-- stored plaintext and validated (http/https) at the route boundary.
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS base_url TEXT NULL;

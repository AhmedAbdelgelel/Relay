
import type { SqlClient } from "../cache/PgVectorStore.js";
import {
  apiKeyPrefixOf,
  classifyApiKeyRow,
  generateApiKey,
  hashApiKey,
  type ApiKeyRecord,
  type ApiKeyStore,
  type CreateApiKeyInput,
  type CreateApiKeyResult,
  type ListApiKeysResult,
  type RevokeApiKeyResult,
  type RotateApiKeyResult,
  type VerifyApiKeyResult,
} from "./ApiKeyStore.js";
import type {
  CredentialGetResult,
  CredentialRemoveResult,
  CredentialSaveResult,
  CredentialStore,
} from "./CredentialStore.js";
import type { CredentialCipher } from "./credentialCipher.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_COLUMNS = "id, tenant_id, provider, name, key_prefix, expires_at, revoked_at, created_at";

interface KeyRow {
  id: string;
  tenant_id: string;
  provider: string;
  name: string;
  key_prefix: string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function rowToApiKeyRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: String(row.id),
    tenant: row.tenant_id,
    provider: row.provider,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: toIso(row.created_at),
    expiresAt: toIsoOrNull(row.expires_at),
    revokedAt: toIsoOrNull(row.revoked_at),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PgApiKeyStore implements ApiKeyStore {
  readonly name = "pg";

  constructor(private readonly db: SqlClient) {}

  async verify(rawKey: string): Promise<VerifyApiKeyResult> {
    if (!rawKey) return { status: "invalid" };
    let rows: KeyRow[];
    try {
      ({ rows } = await this.db.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM api_keys WHERE key_hash = $1`,
        [hashApiKey(rawKey)],
      ));
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
    const row = rows[0];
    if (!row) return { status: "invalid" };
    return classifyApiKeyRow(rowToApiKeyRecord(row));
  }

  async create(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const key = generateApiKey();
    const keyPrefix = apiKeyPrefixOf(key);
    try {
      const { rows } = await this.db.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO api_keys (tenant_id, provider, name, key_prefix, key_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [input.tenant, input.provider, input.name, keyPrefix, hashApiKey(key), input.expiresAt ?? null],
      );
      const row = rows[0];
      if (!row) return { status: "unavailable", reason: "insert returned no row" };
      return {
        status: "created",
        issued: {
          key,
          record: {
            id: String(row.id),
            tenant: input.tenant,
            provider: input.provider,
            name: input.name,
            keyPrefix,
            createdAt: toIso(row.created_at),
            expiresAt: input.expiresAt ?? null,
            revokedAt: null,
          },
        },
      };
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
  }

  async list(tenant?: string): Promise<ListApiKeysResult> {
    try {
      const { rows } =
        tenant === undefined
          ? await this.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at, id`)
          : await this.db.query<KeyRow>(
              `SELECT ${KEY_COLUMNS} FROM api_keys WHERE tenant_id = $1 ORDER BY created_at, id`,
              [tenant],
            );
      return { status: "ok", keys: rows.map(rowToApiKeyRecord) };
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
  }

  async revoke(id: string): Promise<RevokeApiKeyResult> {
    if (!UUID_RE.test(id)) return { status: "not_found" };
    try {
      const { rows } = await this.db.query<KeyRow>(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (!row) return { status: "not_found" };
      return { status: "revoked", record: rowToApiKeyRecord(row) };
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
  }

  async rotate(id: string): Promise<RotateApiKeyResult> {
    if (!UUID_RE.test(id)) return { status: "not_found" };
    const key = generateApiKey();
    const keyPrefix = apiKeyPrefixOf(key);
    try {
      const { rows } = await this.db.query<KeyRow>(
        `WITH old AS (
           UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
            WHERE id = $1
           RETURNING tenant_id, provider, name, expires_at
         )
         INSERT INTO api_keys (tenant_id, provider, name, key_prefix, key_hash, expires_at)
         SELECT tenant_id, provider, name, $2, $3, expires_at FROM old
         RETURNING ${KEY_COLUMNS}`,
        [id, keyPrefix, hashApiKey(key)],
      );
      const row = rows[0];
      if (!row) return { status: "not_found" };
      return { status: "rotated", issued: { key, record: rowToApiKeyRecord(row) } };
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

interface CredentialRow {
  enc_key: string;
}

export class PgCredentialStore implements CredentialStore {
  readonly name = "pg";

  constructor(
    private readonly db: SqlClient,
    private readonly cipher: CredentialCipher,
  ) {}

  async save(tenant: string, provider: string, providerKey: string): Promise<CredentialSaveResult> {
    try {
      await this.db.query(
        `INSERT INTO provider_credentials (tenant_id, provider, enc_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, provider)
         DO UPDATE SET enc_key = EXCLUDED.enc_key, created_at = now()`,
        [tenant, provider, this.cipher.encrypt(providerKey)],
      );
      return { status: "ok" };
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
  }

  async get(tenant: string, provider: string): Promise<CredentialGetResult> {
    let rows: CredentialRow[];
    try {
      ({ rows } = await this.db.query<CredentialRow>(
        `SELECT enc_key FROM provider_credentials WHERE tenant_id = $1 AND provider = $2`,
        [tenant, provider],
      ));
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
    const row = rows[0];
    if (!row) return { status: "not_found" };
    return { status: "ok", providerKey: this.cipher.decrypt(row.enc_key) };
  }

  async remove(tenant: string, provider: string): Promise<CredentialRemoveResult> {
    try {
      const { rows } = await this.db.query<{ tenant_id: string }>(
        `DELETE FROM provider_credentials WHERE tenant_id = $1 AND provider = $2 RETURNING tenant_id`,
        [tenant, provider],
      );
      return rows.length > 0 ? { status: "removed" } : { status: "not_found" };
    } catch (err) {
      return { status: "unavailable", reason: errorMessage(err) };
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

const API_KEYS_TABLE = `CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const PROVIDER_CREDENTIALS_TABLE = `CREATE TABLE IF NOT EXISTS provider_credentials (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  enc_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
)`;

export async function migrateAuthTables(db: SqlClient): Promise<void> {
  await db.query(API_KEYS_TABLE);
  await db.query(PROVIDER_CREDENTIALS_TABLE);
  await db.query(`CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id)`);
}

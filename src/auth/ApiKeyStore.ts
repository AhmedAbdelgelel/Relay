// Port for gateway API keys (agent/implementation.md Part B -> Auth; T24).
// HTTP and guard code depend on this interface, not on SQL: the in-memory
// backend serves zero-setup dev/tests (seeded from GATEWAY_API_KEYS), the pg
// backend serves DATABASE_URL deployments. Both share the same semantics:
// sha256 hex storage, lg_-prefixed keys, plaintext shown exactly once.
//
// Failure model (locked in T24): expected states are typed results, never
// exceptions — a future lane guard (T25) must map
//   invalid        -> 401
//   revoked/expired -> 403
//   unavailable    -> 503 auth_unavailable
// without try/catch control flow. `AuthStoreUnavailable` is the shared shape
// both auth ports use for the store-down state.

import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Every generated gateway key starts with this marker. */
export const API_KEY_PREFIX = "lg_";

/** Display-only prefix length stored alongside the hash (e.g. "lg_ab12c"). */
export const API_KEY_PREFIX_LENGTH = 8;

/** Key metadata safe to return to callers. Never contains hash or plaintext. */
export interface ApiKeyRecord {
  id: string;
  tenant: string;
  provider: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiKeyInput {
  tenant: string;
  provider: string;
  name: string;
  /** ISO 8601; null/absent = never expires. */
  expiresAt?: string | null;
}

/** A key issued by create/rotate. `key` is the plaintext — returned once, never stored. */
export interface IssuedApiKey {
  key: string;
  record: ApiKeyRecord;
}

/** Shared store-down result: both auth ports use this instead of throwing. */
export interface AuthStoreUnavailable {
  status: "unavailable";
  /** Message context only; raw driver errors never leak beyond this. */
  reason?: string;
}

/**
 * verify() outcome. Discriminated on `status` so callers get exhaustiveness
 * checking: revoked/expired/valid carry the record they matched; `invalid` is
 * an unknown key (caller maps to 401); `unavailable` is the store down (503).
 * Revoked takes precedence over expired when both apply.
 */
export type VerifyApiKeyResult =
  | { status: "valid"; key: ApiKeyRecord }
  | { status: "revoked"; key: ApiKeyRecord }
  | { status: "expired"; key: ApiKeyRecord }
  | { status: "invalid" }
  | AuthStoreUnavailable;

export type CreateApiKeyResult = { status: "created"; issued: IssuedApiKey } | AuthStoreUnavailable;

export type ListApiKeysResult = { status: "ok"; keys: ApiKeyRecord[] } | AuthStoreUnavailable;

export type RevokeApiKeyResult =
  | { status: "revoked"; record: ApiKeyRecord }
  | { status: "not_found" }
  | AuthStoreUnavailable;

export type RotateApiKeyResult =
  | { status: "rotated"; issued: IssuedApiKey }
  | { status: "not_found" }
  | AuthStoreUnavailable;

export interface ApiKeyStore {
  readonly name: string;
  /** Hash the presented key and look it up. Never throws for expected states. */
  verify(rawKey: string): Promise<VerifyApiKeyResult>;
  create(input: CreateApiKeyInput): Promise<CreateApiKeyResult>;
  /** Metadata only, optionally filtered by tenant; includes revoked rows (flagged). */
  list(tenant?: string): Promise<ListApiKeysResult>;
  /** Idempotent: re-revoking keeps the original revokedAt. */
  revoke(id: string): Promise<RevokeApiKeyResult>;
  /**
   * Revoke the key identified by id and issue a replacement with the same
   * tenant/provider/name and inherited expiresAt (rotation never extends the
   * grant window). Any existing id may be rotated, including revoked/expired
   * ones. Atomically one statement on pg.
   */
  rotate(id: string): Promise<RotateApiKeyResult>;
  close(): Promise<void>;
}

/** `lg_` + 32 random bytes base64url. High entropy, so plain sha256 storage is safe. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export function apiKeyPrefixOf(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX_LENGTH);
}

export function newApiKeyId(): string {
  return randomUUID();
}

/** Copy of the row's public metadata — internal rows never escape by reference. */
export function toRecord(row: ApiKeyRecord): ApiKeyRecord {
  return { ...row };
}

/**
 * Shared revoked/expired/valid decision so every backend answers identically.
 * An unparseable expiry fails closed (counts as expired).
 */
export function classifyApiKeyRow(row: ApiKeyRecord, now: number = Date.now()): VerifyApiKeyResult {
  if (row.revokedAt) return { status: "revoked", key: toRecord(row) };
  if (row.expiresAt !== null) {
    const expires = Date.parse(row.expiresAt);
    if (!(expires > now)) return { status: "expired", key: toRecord(row) };
  }
  return { status: "valid", key: toRecord(row) };
}

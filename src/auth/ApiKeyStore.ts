
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const API_KEY_PREFIX = "lg_";

export const API_KEY_PREFIX_LENGTH = 8;

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
  expiresAt?: string | null;
}

export interface IssuedApiKey {
  key: string;
  record: ApiKeyRecord;
}

export interface AuthStoreUnavailable {
  status: "unavailable";
  reason?: string;
}

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
  verify(rawKey: string): Promise<VerifyApiKeyResult>;
  create(input: CreateApiKeyInput): Promise<CreateApiKeyResult>;
  list(tenant?: string): Promise<ListApiKeysResult>;
  revoke(id: string): Promise<RevokeApiKeyResult>;
  rotate(id: string): Promise<RotateApiKeyResult>;
  close(): Promise<void>;
}

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

export function toRecord(row: ApiKeyRecord): ApiKeyRecord {
  return { ...row };
}

export function classifyApiKeyRow(row: ApiKeyRecord, now: number = Date.now()): VerifyApiKeyResult {
  if (row.revokedAt) return { status: "revoked", key: toRecord(row) };
  if (row.expiresAt !== null) {
    const expires = Date.parse(row.expiresAt);
    if (!(expires > now)) return { status: "expired", key: toRecord(row) };
  }
  return { status: "valid", key: toRecord(row) };
}

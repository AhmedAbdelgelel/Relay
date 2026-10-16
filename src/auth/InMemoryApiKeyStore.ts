// Zero-setup ApiKeyStore: process memory only, seeded from GATEWAY_API_KEYS
// (hashed at construction — the plaintext seed never sits in a row).
// Same lookup semantics as the pg backend: verify = sha256(raw) -> row.

import type { SeedApiKey } from "../infrastructure/config.js";
import {
  apiKeyPrefixOf,
  classifyApiKeyRow,
  generateApiKey,
  hashApiKey,
  newApiKeyId,
  toRecord,
  type ApiKeyRecord,
  type ApiKeyStore,
  type CreateApiKeyInput,
  type CreateApiKeyResult,
  type ListApiKeysResult,
  type RevokeApiKeyResult,
  type RotateApiKeyResult,
  type VerifyApiKeyResult,
} from "./ApiKeyStore.js";

export class InMemoryApiKeyStore implements ApiKeyStore {
  readonly name = "memory";
  private readonly rows = new Map<string, ApiKeyRecord>();
  private readonly byHash = new Map<string, string>();

  constructor(seedKeys: readonly SeedApiKey[] = []) {
    for (const seed of seedKeys) {
      this.insert({ tenant: seed.tenant, provider: seed.provider, name: seed.name }, seed.key);
    }
  }

  async verify(rawKey: string): Promise<VerifyApiKeyResult> {
    if (!rawKey) return { status: "invalid" };
    const id = this.byHash.get(hashApiKey(rawKey));
    if (id === undefined) return { status: "invalid" };
    const row = this.rows.get(id);
    if (!row) return { status: "invalid" };
    return classifyApiKeyRow(row);
  }

  async create(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    return { status: "created", issued: this.insert(input, generateApiKey()) };
  }

  async list(tenant?: string): Promise<ListApiKeysResult> {
    const keys = [...this.rows.values()]
      .filter((row) => tenant === undefined || row.tenant === tenant)
      .map(toRecord);
    return { status: "ok", keys };
  }

  async revoke(id: string): Promise<RevokeApiKeyResult> {
    const row = this.rows.get(id);
    if (!row) return { status: "not_found" };
    if (!row.revokedAt) row.revokedAt = new Date().toISOString();
    return { status: "revoked", record: toRecord(row) };
  }

  async rotate(id: string): Promise<RotateApiKeyResult> {
    const old = this.rows.get(id);
    if (!old) return { status: "not_found" };
    if (!old.revokedAt) old.revokedAt = new Date().toISOString();
    const issued = this.insert(
      { tenant: old.tenant, provider: old.provider, name: old.name, expiresAt: old.expiresAt },
      generateApiKey(),
    );
    return { status: "rotated", issued };
  }

  async close(): Promise<void> {
    this.rows.clear();
    this.byHash.clear();
  }

  private insert(input: CreateApiKeyInput, plaintext: string): { key: string; record: ApiKeyRecord } {
    const row: ApiKeyRecord = {
      id: newApiKeyId(),
      tenant: input.tenant,
      provider: input.provider,
      name: input.name,
      keyPrefix: apiKeyPrefixOf(plaintext),
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
    this.rows.set(row.id, row);
    this.byHash.set(hashApiKey(plaintext), row.id);
    return { key: plaintext, record: toRecord(row) };
  }
}

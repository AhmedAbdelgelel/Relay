
import type {
  CredentialGetResult,
  CredentialListResult,
  CredentialRemoveResult,
  CredentialSaveResult,
  CredentialStore,
  ProviderConnection,
} from "./CredentialStore.js";
import type { CredentialCipher } from "./credentialCipher.js";

interface StoredCredential {
  encKey: string;
  baseUrl: string | null;
  createdAt: string;
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly name = "memory";
  private readonly rows = new Map<string, Map<string, StoredCredential>>();

  constructor(private readonly cipher: CredentialCipher) {}

  async save(
    tenant: string,
    provider: string,
    providerKey: string,
    baseUrl?: string | null,
  ): Promise<CredentialSaveResult> {
    const byProvider = this.rows.get(tenant) ?? new Map<string, StoredCredential>();
    byProvider.set(provider, {
      encKey: this.cipher.encrypt(providerKey),
      baseUrl: baseUrl ?? null,
      createdAt: new Date().toISOString(),
    });
    this.rows.set(tenant, byProvider);
    return { status: "ok" };
  }

  async get(tenant: string, provider: string): Promise<CredentialGetResult> {
    const row = this.rows.get(tenant)?.get(provider);
    if (!row) return { status: "not_found" };
    return { status: "ok", providerKey: this.cipher.decrypt(row.encKey), baseUrl: row.baseUrl };
  }

  async list(tenant: string): Promise<CredentialListResult> {
    const byProvider = this.rows.get(tenant);
    const connections: ProviderConnection[] = byProvider
      ? [...byProvider.entries()]
          .map(([provider, row]) => ({ provider, baseUrl: row.baseUrl, createdAt: row.createdAt }))
          .sort((a, b) => a.provider.localeCompare(b.provider))
      : [];
    return { status: "ok", connections };
  }

  async remove(tenant: string, provider: string): Promise<CredentialRemoveResult> {
    const byProvider = this.rows.get(tenant);
    if (!byProvider?.delete(provider)) return { status: "not_found" };
    if (byProvider.size === 0) this.rows.delete(tenant);
    return { status: "removed" };
  }

  async close(): Promise<void> {
    this.rows.clear();
  }
}

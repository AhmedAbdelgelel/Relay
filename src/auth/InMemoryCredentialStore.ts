
import type {
  CredentialGetResult,
  CredentialRemoveResult,
  CredentialSaveResult,
  CredentialStore,
} from "./CredentialStore.js";
import type { CredentialCipher } from "./credentialCipher.js";

interface StoredCredential {
  encKey: string;
  createdAt: string;
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly name = "memory";
  private readonly rows = new Map<string, Map<string, StoredCredential>>();

  constructor(private readonly cipher: CredentialCipher) {}

  async save(tenant: string, provider: string, providerKey: string): Promise<CredentialSaveResult> {
    const byProvider = this.rows.get(tenant) ?? new Map<string, StoredCredential>();
    byProvider.set(provider, { encKey: this.cipher.encrypt(providerKey), createdAt: new Date().toISOString() });
    this.rows.set(tenant, byProvider);
    return { status: "ok" };
  }

  async get(tenant: string, provider: string): Promise<CredentialGetResult> {
    const row = this.rows.get(tenant)?.get(provider);
    if (!row) return { status: "not_found" };
    return { status: "ok", providerKey: this.cipher.decrypt(row.encKey) };
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

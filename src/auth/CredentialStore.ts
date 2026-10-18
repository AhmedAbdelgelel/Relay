
import type { AuthStoreUnavailable } from "./ApiKeyStore.js";

export type CredentialSaveResult = { status: "ok" } | AuthStoreUnavailable;

/** One provider connection: the tenant's own upstream key (never returned) + optional base URL. */
export interface ProviderConnection {
  provider: string;
  /** User-supplied upstream base URL; null = the gateway's configured endpoint. */
  baseUrl: string | null;
  /** ISO timestamp of the connect/update. */
  createdAt: string;
}

export type CredentialGetResult =
  | { status: "ok"; providerKey: string; baseUrl: string | null }
  | { status: "not_found" }
  | AuthStoreUnavailable;

export type CredentialListResult =
  | { status: "ok"; connections: ProviderConnection[] }
  | AuthStoreUnavailable;

export type CredentialRemoveResult =
  | { status: "removed" }
  | { status: "not_found" }
  | AuthStoreUnavailable;

export interface CredentialStore {
  readonly name: string;
  /**
   * Upsert the connection for `(tenant, provider)`. The write fully defines
   * the credential: an omitted/empty `baseUrl` resets it to the gateway's
   * configured endpoint (no stale URL survives a reconnect).
   */
  save(
    tenant: string,
    provider: string,
    providerKey: string,
    baseUrl?: string | null,
  ): Promise<CredentialSaveResult>;
  get(tenant: string, provider: string): Promise<CredentialGetResult>;
  /** Connection metadata for one tenant, ordered by provider. Never keys. */
  list(tenant: string): Promise<CredentialListResult>;
  remove(tenant: string, provider: string): Promise<CredentialRemoveResult>;
  close(): Promise<void>;
}

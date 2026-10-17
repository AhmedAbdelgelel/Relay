
import type { AuthStoreUnavailable } from "./ApiKeyStore.js";

export type CredentialSaveResult = { status: "ok" } | AuthStoreUnavailable;

export type CredentialGetResult =
  | { status: "ok"; providerKey: string }
  | { status: "not_found" }
  | AuthStoreUnavailable;

export type CredentialRemoveResult =
  | { status: "removed" }
  | { status: "not_found" }
  | AuthStoreUnavailable;

export interface CredentialStore {
  readonly name: string;
  save(tenant: string, provider: string, providerKey: string): Promise<CredentialSaveResult>;
  get(tenant: string, provider: string): Promise<CredentialGetResult>;
  remove(tenant: string, provider: string): Promise<CredentialRemoveResult>;
  close(): Promise<void>;
}

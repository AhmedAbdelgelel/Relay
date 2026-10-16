// Port for per-tenant provider credentials (agent/implementation.md Part B ->
// Auth; T24). Provider keys are encrypt-on-write / decrypt-on-read: no store
// row ever holds plaintext, and the decrypted value is only ever handed back
// to the composition/guard layer — never to clients.
//
// Failure model: same typed-result pattern as ApiKeyStore (store-down is
// `unavailable`, never an exception). The one deliberate exception is an
// integrity failure: a row that cannot be decrypted (wrong CRED_ENC_KEY or
// tampering) throws a clear error instead of masquerading as not_found, so
// corruption fails loud.

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
  /** Upsert: one credential per (tenant, provider). Encrypts before writing. */
  save(tenant: string, provider: string, providerKey: string): Promise<CredentialSaveResult>;
  /**
   * Decrypt and return the stored provider key, or `not_found`.
   * Throws when the stored row fails decryption (wrong key / tampered data).
   */
  get(tenant: string, provider: string): Promise<CredentialGetResult>;
  remove(tenant: string, provider: string): Promise<CredentialRemoveResult>;
  close(): Promise<void>;
}

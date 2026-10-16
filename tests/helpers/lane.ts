// Shared T26 lane plumbing for tests. Every chat request now runs through the
// lane guard, so test apps must present either a registered gateway key
// (Authorization: Bearer lg_...) or an anonymous x-provider-key. laneAuth()
// issues REAL InMemoryApiKeyStore keys — one per provider name — so the sweep
// exercises the same verify() path as production. Arbitrary provider names are
// allowed because the T26 mismatch check compares the key's provider to the
// routed adapter's name.

import type { ChatRouteDeps } from "../../src/api/routes/chat.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";

export const TEST_TENANT = "test";
/** Dev-only CRED_ENC_KEY for the in-memory credential store (rows stay encrypted). */
const TEST_CRED_SECRET = "test-credential-secret";

export interface TestLane {
  key: string;
  keyId: string;
  tenant: string;
  provider: string;
  headers: { authorization: string };
}

export interface TestLanes {
  auth: ChatRouteDeps["auth"];
  /** Authorization header for the lane issued to `provider`. */
  headersFor(provider: string): { authorization: string };
  /** The issued lane itself (raw key / id / tenant), for assertions and revokes. */
  laneFor(provider: string): TestLane;
}

/** Issue one registered lane per provider name on a fresh memory auth pair. */
export async function laneAuth(...providers: string[]): Promise<TestLanes> {
  const apiKeys = new InMemoryApiKeyStore();
  const credentials = new InMemoryCredentialStore(new CredentialCipher(TEST_CRED_SECRET));
  const lanes = new Map<string, TestLane>();
  for (const provider of providers) {
    lanes.set(provider, await issueLane({ apiKeys, credentials }, provider));
  }
  const get = (provider: string): TestLane => {
    const lane = lanes.get(provider);
    if (!lane) throw new Error(`laneAuth: no lane issued for provider '${provider}'`);
    return lane;
  };
  return {
    auth: { apiKeys, credentials },
    headersFor: (provider) => get(provider).headers,
    laneFor: get,
  };
}

/** Issue an extra registered lane (e.g. a second tenant) on existing stores. */
export async function issueLane(auth: ChatRouteDeps["auth"], provider: string, tenant = TEST_TENANT): Promise<TestLane> {
  const res = await auth.apiKeys.create({ tenant, provider, name: "test" });
  if (res.status !== "created") throw new Error(`issueLane: key creation failed (${res.status})`);
  const { key, record } = res.issued;
  return { key, keyId: record.id, tenant, provider, headers: { authorization: `Bearer ${key}` } };
}

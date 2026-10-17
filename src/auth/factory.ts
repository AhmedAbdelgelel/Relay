
import { createPgClient } from "../cache/PgVectorStore.js";
import type { GatewayConfig } from "../infrastructure/config.js";
import type { ApiKeyStore } from "./ApiKeyStore.js";
import type { CredentialStore } from "./CredentialStore.js";
import { CredentialCipher } from "./credentialCipher.js";
import { InMemoryApiKeyStore } from "./InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "./InMemoryCredentialStore.js";
import { migrateAuthTables, PgApiKeyStore, PgCredentialStore } from "./PgAuthStores.js";

export interface AuthStores {
  apiKeys: ApiKeyStore;
  credentials: CredentialStore;
  close(): Promise<void>;
}

export async function createAuthStoresFromEnv(cfg: GatewayConfig): Promise<AuthStores> {
  const cipher = new CredentialCipher(cfg.credEncKey);
  if (!cfg.databaseUrl) {
    const apiKeys = new InMemoryApiKeyStore(cfg.gatewayApiKeys);
    const credentials = new InMemoryCredentialStore(cipher);
    return {
      apiKeys,
      credentials,
      async close() {
        await apiKeys.close();
        await credentials.close();
      },
    };
  }
  const client = createPgClient(cfg.databaseUrl);
  try {
    await migrateAuthTables(client);
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return {
    apiKeys: new PgApiKeyStore(client),
    credentials: new PgCredentialStore(client, cipher),
    close: () => client.close(),
  };
}

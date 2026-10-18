
import "dotenv/config";
import Fastify from "fastify";
import { registerChatRoutes } from "./api/routes/chat.js";
import { registerConnectionsRoutes } from "./api/routes/connections.js";
import { registerPlayground } from "./api/routes/playground.js";
import { registerProviderRoutes } from "./api/routes/providers.js";
import { registerRegisterRoutes } from "./api/routes/register.js";
import { registerUsageRoutes } from "./api/routes/usage.js";
import { CredentialCipher } from "./auth/credentialCipher.js";
import { createAuthStoresFromEnv } from "./auth/factory.js";
import { InMemoryApiKeyStore } from "./auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "./auth/InMemoryCredentialStore.js";
import { createCacheFromEnv } from "./cache/factory.js";
import { InMemoryVectorStore } from "./cache/InMemoryVectorStore.js";
import { createSemanticStoreFromEnv } from "./cache/semanticFactory.js";
import { createEmbedderFromEnv } from "./embeddings/factory.js";
import type { EmbeddingProvider } from "./embeddings/EmbeddingProvider.js";
import { loadConfig } from "./infrastructure/config.js";
import { log } from "./infrastructure/logger.js";
import { createProviderFromEnv, createProvidersFromEnv } from "./providers/factory.js";

function warmEmbedder(embedder: EmbeddingProvider | undefined): void {
  if (embedder?.name !== "local") return;
  void embedder.embed("warmup", AbortSignal.timeout(60_000)).catch(() => undefined);
}

export function buildServer() {
  const cfg = loadConfig();
  const app = Fastify({ logger: false });
  const provider = createProviderFromEnv(cfg);
  const providers = createProvidersFromEnv(cfg);
  const cache = createCacheFromEnv(cfg);
  const semanticStore = cfg.semanticEnabled && cfg.semanticStore === "memory" ? new InMemoryVectorStore() : undefined;
  const embedder = cfg.semanticEnabled && semanticStore ? createEmbedderFromEnv(cfg) : undefined;
  warmEmbedder(embedder);
  const auth = {
    apiKeys: new InMemoryApiKeyStore(cfg.gatewayApiKeys),
    credentials: new InMemoryCredentialStore(new CredentialCipher(cfg.credEncKey)),
  };
  registerChatRoutes(app, provider, cfg, cache, { semanticStore, embedder, providers, auth });
  registerRegisterRoutes(app, auth);
  registerConnectionsRoutes(app, cfg, auth);
  registerUsageRoutes(app, auth);
  registerProviderRoutes(app, cfg, providers);
  registerPlayground(app);
  return { app, cfg, provider, providers, cache, semanticStore, embedder, auth };
}

export async function buildServerAsync() {
  const cfg = loadConfig();
  const app = Fastify({ logger: false });
  const provider = createProviderFromEnv(cfg);
  const providers = createProvidersFromEnv(cfg);
  const cache = createCacheFromEnv(cfg);
  const semanticStore = await createSemanticStoreFromEnv(cfg);
  const embedder = semanticStore ? createEmbedderFromEnv(cfg) : undefined;
  warmEmbedder(embedder);
  const auth = await createAuthStoresFromEnv(cfg);
  registerChatRoutes(app, provider, cfg, cache, { semanticStore, embedder, providers, auth });
  registerRegisterRoutes(app, auth);
  registerConnectionsRoutes(app, cfg, auth);
  registerUsageRoutes(app, auth);
  registerProviderRoutes(app, cfg, providers);
  registerPlayground(app);
  return { app, cfg, provider, providers, cache, semanticStore, embedder, auth };
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain && !process.env.VITEST) {
  buildServerAsync().then(({ app, cfg, provider, cache, semanticStore }) => {
    app.listen({ port: cfg.port, host: "0.0.0.0" }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      log({ msg: `gateway up provider=${provider.name} cache=${cache.name} semantic=${semanticStore?.name ?? "none"}`, address });
    });
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

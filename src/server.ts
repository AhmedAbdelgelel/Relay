// server.ts — composition root. Only file allowed to wire config -> provider -> routes.
// CHOOSING happens here via createProviderFromEnv; routes never choose.

import "dotenv/config";
import Fastify from "fastify";
import { registerChatRoutes } from "./api/routes/chat.js";
import { loadConfig } from "./infrastructure/config.js";
import { log } from "./infrastructure/logger.js";
import { createProviderFromEnv } from "./providers/factory.js";

export function buildServer() {
  const cfg = loadConfig();
  const app = Fastify({ logger: false });
  const provider = createProviderFromEnv(cfg);
  registerChatRoutes(app, provider, cfg);
  return { app, cfg, provider };
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
// Do not auto-listen when imported by vitest (loop.md: tests must boot via buildServer + inject).
if (isMain && !process.env.VITEST) {
  const { app, cfg, provider } = buildServer();
  app.listen({ port: cfg.port, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    log({ msg: `gateway up provider=${provider.name}`, address });
  });
}

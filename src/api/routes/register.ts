
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiKeyStore } from "../../auth/ApiKeyStore.js";
import type { CredentialStore } from "../../auth/CredentialStore.js";
import { PROVIDER_NAMES } from "../../infrastructure/config.js";
import { log } from "../../infrastructure/logger.js";
import { BaseUrlSchema } from "./baseUrl.js";

export interface RegisterRouteDeps {
  apiKeys: ApiKeyStore;
  credentials: CredentialStore;
}

const BodySchema = z.object({
  name: z.string().min(1, "name is required"),
  provider: z.enum(PROVIDER_NAMES, {
    errorMap: () => ({ message: `provider must be one of ${PROVIDER_NAMES.join("|")}` }),
  }),
  provider_key: z.string().min(1, "provider_key is required"),
  base_url: BaseUrlSchema.optional(),
});

export function registerRegisterRoutes(app: FastifyInstance, deps: RegisterRouteDeps): void {
  app.post("/v1/register", async (request, reply) => {
    const requestId = (request.headers["x-request-id"] as string) || randomUUID();
    reply.header("x-request-id", requestId);

    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      log({ request_id: requestId, status: 400, error_code: "invalid_request" });
      return reply.status(400).send({ error: { code: "invalid_request", message: msg, request_id: requestId } });
    }

    const { name, provider, provider_key: providerKey } = parsed.data;
    const baseUrl = parsed.data.base_url ?? null;
    const tenant = randomUUID();

    const saved = await deps.credentials.save(tenant, provider, providerKey, baseUrl);
    if (saved.status === "unavailable") {
      log({ request_id: requestId, status: 503, error_code: "auth_unavailable", ...(saved.reason ? { error: saved.reason } : {}) });
      return reply.status(503).send({
        error: { code: "auth_unavailable", message: "credential store unavailable, retry shortly", request_id: requestId },
      });
    }

    const created = await deps.apiKeys.create({ tenant, provider, name });
    if (created.status === "unavailable") {
      log({ request_id: requestId, status: 503, error_code: "auth_unavailable", ...(created.reason ? { error: created.reason } : {}) });
      return reply.status(503).send({
        error: { code: "auth_unavailable", message: "key store unavailable, retry shortly", request_id: requestId },
      });
    }

    const { key, record } = created.issued;
    log({ request_id: requestId, status: 201, tenant_id: tenant, provider, key_prefix: record.keyPrefix, ...(baseUrl ? { base_url: baseUrl } : {}) });
    return reply.status(201).send({ tenant_id: tenant, provider, key, key_prefix: record.keyPrefix });
  });
}

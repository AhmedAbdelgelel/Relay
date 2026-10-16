// POST /v1/register (T27): open signup — validate, store the provider key
// ENCRYPTED, issue a gateway key, return it exactly once.
//
// Flow (R2): zod body { name, provider: enum(PROVIDER_NAMES), provider_key }
// -> 400 invalid_request on invalid input or an unknown provider; then
// tenant_id = randomUUID(); credentials.save(tenant, provider, provider_key);
// apiKeys.create({ tenant, provider, name }). Either store reporting
// `unavailable` -> 503 auth_unavailable (the guard's vocabulary). A credential
// orphaned by a failed key-create is acceptable: the tenant id was never
// disclosed, so a retry simply mints a fresh tenant — and nothing can be
// served until a gateway key exists.
//
// 201 body is EXACTLY { tenant_id, provider, key, key_prefix }: `key` is the
// plaintext gateway key, shown once (the store keeps only its sha256), and
// `key_prefix` is the record's display prefix. Key-material contract: the log
// line carries { request_id, tenant_id, provider, key_prefix } and NEVER the
// provider_key or the issued key; nothing here is counted as an auth
// rejection (no identity was presented — R1).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiKeyStore } from "../../auth/ApiKeyStore.js";
import type { CredentialStore } from "../../auth/CredentialStore.js";
import { PROVIDER_NAMES } from "../../infrastructure/config.js";
import { log } from "../../infrastructure/logger.js";

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
    const tenant = randomUUID();

    const saved = await deps.credentials.save(tenant, provider, providerKey);
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
    log({ request_id: requestId, status: 201, tenant_id: tenant, provider, key_prefix: record.keyPrefix });
    return reply.status(201).send({ tenant_id: tenant, provider, key, key_prefix: record.keyPrefix });
  });
}

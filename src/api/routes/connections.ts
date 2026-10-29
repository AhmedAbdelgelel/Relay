
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiKeyStore } from "../../auth/ApiKeyStore.js";
import type { CredentialStore } from "../../auth/CredentialStore.js";
import { createLaneGuard } from "../../auth/laneGuard.js";
import { PROVIDER_NAMES, type GatewayConfig } from "../../infrastructure/config.js";
import { log } from "../../infrastructure/logger.js";
import { metrics } from "../../observability/metrics.js";
import { defaultEndpointFor } from "../../providers/factory.js";
import { BaseUrlSchema, providerUrlPolicy, validateProviderBaseUrl } from "./baseUrl.js";

export interface ConnectionsRouteDeps {
  apiKeys: ApiKeyStore;
  credentials: CredentialStore;
}

const BodySchema = z.object({
  provider: z.enum(PROVIDER_NAMES, {
    errorMap: () => ({ message: `provider must be one of ${PROVIDER_NAMES.join("|")}` }),
  }),
  provider_key: z.string().min(1, "provider_key is required"),
  base_url: BaseUrlSchema.optional(),
});

const CONNECTIONS_REQUIRE_KEY =
  "provider connections are managed with a registered gateway key: send 'Authorization: Bearer <gateway-key>' " +
  "(register at POST /v1/register); the anonymous try-out lane cannot store credentials";

export function registerConnectionsRoutes(
  app: FastifyInstance,
  cfg: GatewayConfig,
  deps: ConnectionsRouteDeps,
): void {
  const laneGuard = createLaneGuard(app, deps.apiKeys);

  function registeredTenant(request: FastifyRequest, reply: FastifyReply, requestId: string): string | null {
    const auth = request.auth!;
    if (auth.lane === "registered") return auth.tenant;
    metrics.inc("auth_rejects_total");
    log({ request_id: requestId, status: 401, error_code: "missing_api_key", lane: auth.lane });
    reply.header("x-request-id", requestId);
    reply.status(401).send({ error: { code: "missing_api_key", message: CONNECTIONS_REQUIRE_KEY, request_id: requestId } });
    return null;
  }

  app.post("/v1/connections", { preHandler: laneGuard }, async (request, reply) => {
    const requestId = (request.headers["x-request-id"] as string) || randomUUID();
    reply.header("x-request-id", requestId);

    const tenant = registeredTenant(request, reply, requestId);
    if (tenant === null) return reply;

    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      log({ request_id: requestId, status: 400, error_code: "invalid_request" });
      return reply.status(400).send({ error: { code: "invalid_request", message: msg, request_id: requestId } });
    }

    const { provider, provider_key: providerKey } = parsed.data;
    let baseUrl = parsed.data.base_url ?? null;
    if (baseUrl !== null) {
      // Same SSRF policy as registration; reject/resolve before the credential
      // upsert so a rejected URL cannot replace a working connection.
      const check = await validateProviderBaseUrl(baseUrl, {
        policy: providerUrlPolicy(cfg.allowPrivateProviderUrls),
      });
      if (!check.ok) {
        log({ request_id: requestId, status: 400, error_code: "invalid_request", base_url_rejected: true });
        return reply.status(400).send({
          error: { code: "invalid_request", message: `base_url: ${check.error}`, request_id: requestId },
        });
      }
      // Keep the submitted (trimmed) form for API compatibility; validation\n      // used the canonical URL/DNS result.\n      baseUrl = baseUrl.trim();
    }

    const saved = await deps.credentials.save(tenant, provider, providerKey, baseUrl);
    if (saved.status === "unavailable") {
      log({ request_id: requestId, status: 503, error_code: "auth_unavailable", ...(saved.reason ? { error: saved.reason } : {}) });
      return reply.status(503).send({
        error: { code: "auth_unavailable", message: "credential store unavailable, retry shortly", request_id: requestId },
      });
    }

    const endpoint = baseUrl ?? defaultEndpointFor(provider, cfg);
    let endpointHost = endpoint;
    try {
      endpointHost = new URL(endpoint).host;
    } catch {
      /* non-URL endpoints (e.g. mock "in-process") log verbatim */
    }
    log({
      request_id: requestId,
      status: 201,
      provider,
      endpoint_host: endpointHost,
      connected: true,
    });
    return reply.status(201).send({ provider, base_url: baseUrl, endpoint, connected: true });
  });

  app.get("/v1/connections", { preHandler: laneGuard }, async (request, reply) => {
    const requestId = (request.headers["x-request-id"] as string) || randomUUID();
    reply.header("x-request-id", requestId);

    const tenant = registeredTenant(request, reply, requestId);
    if (tenant === null) return reply;

    const listed = await deps.credentials.list(tenant);
    if (listed.status === "unavailable") {
      log({ request_id: requestId, status: 503, error_code: "auth_unavailable", ...(listed.reason ? { error: listed.reason } : {}) });
      return reply.status(503).send({
        error: { code: "auth_unavailable", message: "credential store unavailable, retry shortly", request_id: requestId },
      });
    }

    return reply.send({
      tenant_id: tenant,
      connections: listed.connections.map((connection) => ({
        provider: connection.provider,
        base_url: connection.baseUrl,
        endpoint: connection.baseUrl ?? defaultEndpointFor(connection.provider, cfg),
        created_at: connection.createdAt,
      })),
    });
  });
}


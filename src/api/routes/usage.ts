// GET /v1/usage (T27): the caller's OWN tenant slice from the T26 per-tenant
// records. Gated by the same T25 lane guard as chat (registered = verified
// gateway key); no key / bad key / revoked / expired / store down come free
// from the guard. The anonymous try-out lane has no tenant to report on, so
// it is rejected here with a clear pointer at registration and counted as an
// auth rejection (R1).
//
// The success body is exactly metrics.tenantSnapshot(tenant): the caller's
// numbers plus the tenant id — never key material, and never another tenant's
// slice (tenant comes from the verified key only; x-tenant-id is ignored).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../../auth/ApiKeyStore.js";
import { createLaneGuard } from "../../auth/laneGuard.js";
import { log } from "../../infrastructure/logger.js";
import { metrics } from "../../observability/metrics.js";

export interface UsageRouteDeps {
  apiKeys: ApiKeyStore;
}

const USAGE_REQUIRES_KEY =
  "GET /v1/usage requires a registered gateway key: send 'Authorization: Bearer <gateway-key>' " +
  "(register at POST /v1/register)";

export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): void {
  // createLaneGuard is idempotent per app (T25), so chat + usage freely each
  // build their own preHandler over the same store.
  const laneGuard = createLaneGuard(app, deps.apiKeys);

  app.get("/v1/usage", { preHandler: laneGuard }, async (request, reply) => {
    const requestId = (request.headers["x-request-id"] as string) || randomUUID();
    const auth = request.auth!;
    if (auth.lane !== "registered") {
      // Anonymous (x-provider-key) seats have no tenant to report on.
      metrics.inc("auth_rejects_total");
      log({ request_id: requestId, status: 401, error_code: "missing_api_key", lane: auth.lane });
      reply.header("x-request-id", requestId);
      return reply.status(401).send({ error: { code: "missing_api_key", message: USAGE_REQUIRES_KEY, request_id: requestId } });
    }
    // Caller's own slice ONLY: metrics.tenantSnapshot never returns other tenants.
    return reply.send(metrics.tenantSnapshot(auth.tenant));
  });
}

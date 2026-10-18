
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { GatewayError } from "../domain/types.js";
import { log } from "../infrastructure/logger.js";
import { metrics } from "../observability/metrics.js";
import type { ApiKeyStore } from "./ApiKeyStore.js";

export type LaneAuth =
  | {
      lane: "registered";
      tenant: string;
      provider: string;
      keyId: string;
    }
  | {
      lane: "anonymous";
      providerKey: string;
    };

declare module "fastify" {
  interface FastifyRequest {
    auth: LaneAuth | null;
  }
}

const REGISTER_HINT =
  "missing API key: send 'Authorization: Bearer <gateway-key>' (or 'x-api-key'), " +
  "register for a gateway key at POST /v1/register, " +
  "or use 'x-provider-key' for the anonymous try-out lane";

function headerString(request: FastifyRequest, name: string): string {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

function presentedGatewayKey(request: FastifyRequest): string | null {
  const authorization = headerString(request, "authorization");
  if (authorization !== "") {
    const m = authorization.match(/^bearer\s+(.*)$/i);
    return m ? (m[1] ?? "").trim() : "";
  }
  const apiKey = headerString(request, "x-api-key");
  return apiKey !== "" ? apiKey : null;
}

function authReject(
  reply: FastifyReply,
  requestId: string,
  status: number,
  code: string,
  message: string,
  storeError?: string,
): FastifyReply {
  metrics.inc("auth_rejects_total");
  log({
    request_id: requestId,
    status,
    error_code: code,
    ...(storeError ? { error: storeError } : {}),
  });
  reply.header("x-request-id", requestId);
  return reply.status(status).send({ error: { code, message, request_id: requestId } });
}

export function createLaneGuard(app: FastifyInstance, apiKeys: ApiKeyStore): preHandlerAsyncHookHandler {
  if (!app.hasRequestDecorator("auth")) app.decorateRequest("auth", null);

  return async function laneGuard(request, reply) {
    const requestId = headerString(request, "x-request-id") || randomUUID();
    const gatewayKey = presentedGatewayKey(request);

    if (gatewayKey !== null) {
      const result = await apiKeys.verify(gatewayKey);
      if (result.status === "valid") {
        request.auth = {
          lane: "registered",
          tenant: result.key.tenant,
          provider: result.key.provider,
          keyId: result.key.id,
        };
        return;
      }
      if (result.status === "revoked") {
        return authReject(reply, requestId, 403, "key_revoked", "gateway key has been revoked");
      }
      if (result.status === "expired") {
        return authReject(reply, requestId, 403, "key_expired", "gateway key has expired");
      }
      if (result.status === "unavailable") {
        return authReject(
          reply,
          requestId,
          503,
          "auth_unavailable",
          "authentication store unavailable, retry shortly",
          result.reason,
        );
      }
      return authReject(reply, requestId, 401, "invalid_api_key", "unknown gateway key");
    }

    const providerKey = headerString(request, "x-provider-key");
    if (providerKey !== "") {
      request.auth = { lane: "anonymous", providerKey };
      return;
    }

    return authReject(reply, requestId, 401, "missing_api_key", REGISTER_HINT);
  };
}

export function laneProviderMismatch(
  auth: LaneAuth,
  servingProvider: string,
  tenantConnected = false,
): GatewayError | null {
  if (auth.lane !== "registered" || auth.provider === servingProvider || tenantConnected) return null;
  return new GatewayError(
    403,
    "provider_mismatch",
    `gateway key is bound to provider '${auth.provider}' but the request routes to '${servingProvider}'; ` +
      `connect '${servingProvider}' with your own key (POST /v1/connections) to route it on this gateway key`,
    false,
  );
}

// Lane guard (T25): one preHandler owns lane picking and the auth error
// vocabulary for the chat endpoint (agent/implementation.md Part B -> Auth;
// INV-9). It runs before validation, provider selection, and cache lookup, so
// a rejected request never spends anything.
//
// Lanes (precedence: Authorization > x-api-key > x-provider-key):
//   - gateway key present  -> registered: verify against the ApiKeyStore and
//     attach { lane, tenant, provider, keyId } to request.auth. A present
//     Authorization header is ALWAYS a registered attempt: a bad/revoked/
//     expired key is answered 401/403/503 — it never silently falls back to
//     the anonymous lane (that would mask revocation).
//   - only x-provider-key  -> anonymous: attach { lane, providerKey }. The
//     upstream key is handed to the provider layer only; it is never logged
//     or echoed.
//   - neither              -> 401 with a register hint.
//
// Error map (typed results from ApiKeyStore.verify, no exceptions):
//   invalid -> 401 invalid_api_key        revoked -> 403 key_revoked
//   expired -> 403 key_expired            store down -> 503 auth_unavailable
// Provider mismatch (registered lane serving another provider) -> 403
// provider_mismatch; the guard cannot know the serving provider before body
// validation, so laneProviderMismatch() is exported for the chat route to
// apply after routing (T26).
//
// Attachment mechanism (T25 decision): Fastify decorateRequest("auth", null)
// + module augmentation, so consumers read typed `request.auth` exactly as
// Part B names it. The decoration is idempotent per app; rejected requests
// leave it null.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { GatewayError } from "../domain/types.js";
import { log } from "../infrastructure/logger.js";
import { metrics } from "../observability/metrics.js";
import type { ApiKeyStore } from "./ApiKeyStore.js";

/** Request-scoped lane context. Key material is never part of a registered lane. */
export type LaneAuth =
  | {
      lane: "registered";
      tenant: string;
      provider: string;
      /** api_keys.id — the x-key-id evidence header value (T26). */
      keyId: string;
    }
  | {
      lane: "anonymous";
      /** Upstream key from x-provider-key; passed to the provider layer, never logged/echoed. */
      providerKey: string;
    };

declare module "fastify" {
  interface FastifyRequest {
    /** Set by createLaneGuard on accepted requests; null until then (and on rejections). */
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

/**
 * The presented gateway key, or null when no gateway header is present.
 * A present-but-unusable Authorization header (non-Bearer scheme, empty
 * token) yields "" — it counts as a bad key (401), not as absence.
 */
function presentedGatewayKey(request: FastifyRequest): string | null {
  const authorization = headerString(request, "authorization");
  if (authorization !== "") {
    const m = authorization.match(/^bearer\s+(.*)$/i);
    return m ? (m[1] ?? "").trim() : "";
  }
  const apiKey = headerString(request, "x-api-key");
  return apiKey !== "" ? apiKey : null;
}

/** 401/403/503 in the app's standard envelope; never includes key material. */
function authReject(
  reply: FastifyReply,
  requestId: string,
  status: number,
  code: string,
  message: string,
  storeError?: string,
): FastifyReply {
  // T27/R1: every guard rejection counts once; accepted lanes never touch this.
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

/**
 * Build the preHandler for one ApiKeyStore. Call once per Fastify app
 * (decoration is idempotent); register the result as a route preHandler.
 */
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
        // Store-side context goes to the log line only; clients get a fixed message.
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

/**
 * Post-routing check for the registered lane: a gateway key serves only the
 * provider it was issued for (403 provider_mismatch otherwise). Anonymous
 * lanes have no provider binding. Runs after body validation because the
 * serving provider is derived from the model (T26 wires the call).
 */
export function laneProviderMismatch(auth: LaneAuth, servingProvider: string): GatewayError | null {
  if (auth.lane !== "registered" || auth.provider === servingProvider) return null;
  return new GatewayError(
    403,
    "provider_mismatch",
    `gateway key is bound to provider '${auth.provider}' but the request routes to '${servingProvider}'`,
    false,
  );
}

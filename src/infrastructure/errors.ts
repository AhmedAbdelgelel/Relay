// infrastructure/errors.ts — STANDARDIZATION: every provider failure becomes a GatewayError.
// HTTP layer only switches on GatewayError. No SDK bodies/stacks leak to clients.

import { GatewayError } from "../domain/types.js";

export function providerHttpError(provider: string, status: number, bodyText: string): GatewayError {
  const snippet = bodyText.slice(0, 300);
  if (status === 429) {
    return new GatewayError(429, "provider_rate_limited", `${provider} rate limited. ${snippet}`, true);
  }
  if (status === 401 || status === 403) {
    return new GatewayError(502, "provider_auth_error", `${provider} auth failed (${status}). Check API key.`, false);
  }
  if (status === 404) {
    return new GatewayError(502, "provider_not_found", `${provider} 404: model or endpoint missing. ${snippet}`, false);
  }
  if (status >= 500) {
    return new GatewayError(502, "provider_error", `${provider} upstream ${status}. ${snippet}`, true);
  }
  return new GatewayError(502, "provider_error", `${provider} upstream ${status}. ${snippet}`, false);
}

export function toGatewayError(provider: string, err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return new GatewayError(504, "gateway_timeout", `${provider} timed out or request aborted.`, true);
    }
    return new GatewayError(502, "provider_error", `${provider} network error: ${err.message}`, true);
  }
  return new GatewayError(502, "provider_error", `${provider} unknown error`, true);
}

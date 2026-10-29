
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

/**
 * Redact secret material from a message before it leaves the process (HTTP
 * error bodies, logs). Exact known secrets are replaced first; common key
 * shapes are caught as defense-in-depth because upstream error bodies can echo
 * a provider key fragment that the gateway did not construct.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  const patterns = [
    /sk-[A-Za-z0-9_-]{12,}/g,
    /AIza[0-9A-Za-z_-]{20,}/g,
    /lg_[A-Za-z0-9_-]{10,}/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  ];
  for (const pattern of patterns) out = out.replace(pattern, "[redacted]");
  return out;
}

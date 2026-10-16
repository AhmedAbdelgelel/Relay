/**
 * Typed browser client for the Relay gateway.
 *
 * Base URL resolution: a custom `baseUrl` from the connection (persisted in
 * localStorage under `llm-gateway-api-v1`) or same-origin (""), which routes
 * through the Next rewrites in next.config.ts — no CORS, no keys in the
 * bundle. All requests are `cache: "no-store"` so polled surfaces stay live.
 */

import type {
  CacheVerdict,
  ChatCompletion,
  ChatPayload,
  Connection,
  Evidence,
  HealthInfo,
  Lane,
  MetricsSnapshot,
  ProviderStatus,
  StreamChunk,
  Usage,
} from "./types";

export const CONNECTION_KEY = "llm-gateway-api-v1";

/** Parseable error from the gateway: `{ error: { code, message, request_id, retry_after? } }`. */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfter: number | null;
  readonly evidence: Evidence | null;
  readonly payload: unknown;

  constructor(
    message: string,
    status: number,
    options?: {
      code?: string | null;
      retryAfter?: number | null;
      evidence?: Evidence | null;
      payload?: unknown;
    },
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = options?.code ?? null;
    this.retryAfter = options?.retryAfter ?? null;
    this.evidence = options?.evidence ?? null;
    this.payload = options?.payload;
  }
}

interface GatewayErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    retry_after?: number;
  };
}

function errorFrom(status: number, json: unknown, evidence: Evidence | null): GatewayError {
  const body = (json ?? null) as GatewayErrorBody | null;
  const message = body?.error?.message ?? `Gateway request failed with status ${status}`;
  return new GatewayError(message, status, {
    code: body?.error?.code ?? null,
    retryAfter: typeof body?.error?.retry_after === "number" ? body.error.retry_after : null,
    evidence,
    payload: json,
  });
}

export function resolveBaseUrl(baseUrl: string): string {
  return (baseUrl || "").replace(/\/+$/, "");
}

/** Read the persisted connection. SSR-safe: returns same-origin when there is no window. */
export function loadConnection(): Connection {
  if (typeof window === "undefined") return { baseUrl: "", apiKey: "" };
  try {
    const raw = window.localStorage.getItem(CONNECTION_KEY);
    if (!raw) return { baseUrl: "", apiKey: "" };
    const parsed = JSON.parse(raw) as Partial<Connection> | null;
    return {
      baseUrl: typeof parsed?.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return { baseUrl: "", apiKey: "" };
  }
}

/** Persist the connection. SSR-safe no-op when there is no window. */
export function saveConnection(connection: Connection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
  } catch {
    /* storage disabled: keep the in-memory connection only */
  }
}

/** Request id for `x-request-id` (event-handler context only, never render). */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const VERDICTS: readonly CacheVerdict[] = ["HIT", "SEMANTIC_HIT", "MISS", "DISABLED", "BYPASS"];

function cacheVerdict(value: string | null): CacheVerdict | null {
  return value !== null && (VERDICTS as readonly string[]).includes(value)
    ? (value as CacheVerdict)
    : null;
}

/** Read every evidence header off a response. Missing headers become null. */
export function evidenceFrom(headers: Headers): Evidence {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const bool = (name: string): boolean | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    return raw === "true";
  };
  const laneRaw = headers.get("x-lane");
  const lane: Lane | null = laneRaw === "registered" || laneRaw === "anonymous" ? laneRaw : null;
  return {
    requestId: headers.get("x-request-id"),
    lane,
    keyId: headers.get("x-key-id"),
    provider: headers.get("x-provider"),
    cache: cacheVerdict(headers.get("x-cache")),
    cacheHash: headers.get("x-cache-hash"),
    latencyMs: num("x-latency-ms"),
    coalesced: bool("x-coalesced"),
    semanticSimilarity: num("x-semantic-similarity"),
    fallback: bool("x-fallback"),
  };
}

export interface ChatInit {
  signal?: AbortSignal;
  requestId?: string;
}

export interface ChatResult {
  json: ChatCompletion;
  evidence: Evidence;
  status: number;
}

export interface ChatStreamOptions extends ChatInit {
  onChunk?: (chunk: StreamChunk) => void;
  onUsage?: (usage: Usage) => void;
}

export interface StreamResult {
  text: string;
  usage: Usage | null;
  chunks: number;
  evidence: Evidence;
  status: number;
  /** True when the caller aborted (partial `text` is still preserved). */
  aborted: boolean;
}

export class GatewayClient {
  readonly baseUrl: string;
  readonly apiKey: string;

  constructor(connection: Connection = loadConnection()) {
    this.baseUrl = resolveBaseUrl(connection.baseUrl);
    this.apiKey = connection.apiKey ?? "";
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  async health(signal?: AbortSignal): Promise<HealthInfo> {
    const res = await fetch(this.url("/health"), {
      headers: this.headers(),
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw errorFrom(res.status, null, null);
    return (await res.json()) as HealthInfo;
  }

  async metrics(signal?: AbortSignal): Promise<MetricsSnapshot> {
    const res = await fetch(this.url("/metrics"), {
      headers: this.headers(),
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw errorFrom(res.status, null, null);
    return (await res.json()) as MetricsSnapshot;
  }

  async providers(signal?: AbortSignal): Promise<ProviderStatus[]> {
    const res = await fetch(this.url("/providers"), {
      // `Accept` must stay application/json: it is what routes the request to
      // the gateway instead of the /providers page (see next.config.ts).
      headers: this.headers({ Accept: "application/json" }),
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw errorFrom(res.status, null, null);
    return (await res.json()) as ProviderStatus[];
  }

  async chat(body: ChatPayload, init: ChatInit = {}): Promise<ChatResult> {
    const res = await fetch(this.url("/v1/chat/completions"), {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        "x-request-id": init.requestId ?? newRequestId(),
      }),
      body: JSON.stringify(body),
      signal: init.signal,
    });
    const evidence = evidenceFrom(res.headers);
    const json = (await res.json().catch(() => null)) as ChatCompletion | null;
    if (!res.ok) throw errorFrom(res.status, json, evidence);
    if (json === null) throw errorFrom(res.status, null, evidence);
    return { json, evidence, status: res.status };
  }

  async chatStream(body: ChatPayload, options: ChatStreamOptions = {}): Promise<StreamResult> {
    const res = await fetch(this.url("/v1/chat/completions"), {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-request-id": options.requestId ?? newRequestId(),
      }),
      body: JSON.stringify({ ...body, stream: true }),
      signal: options.signal,
    });
    const evidence = evidenceFrom(res.headers);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw errorFrom(res.status, json, evidence);
    }
    const { text, usage, chunks } = await readSSE(res, options);
    return {
      text,
      usage,
      chunks,
      evidence,
      status: res.status,
      aborted: options.signal?.aborted ?? false,
    };
  }
}

/**
 * Parse the gateway's SSE framing exactly like legacy api.js:
 * `data: {...}` frames, optional terminal `usage` frame, `data: [DONE]`.
 * Aborts and socket errors keep the partial text (inventory rough edge #8).
 */
async function readSSE(
  response: Response,
  options: ChatStreamOptions,
): Promise<{ text: string; usage: Usage | null; chunks: number }> {
  if (!response.body) return { text: "", usage: null, chunks: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: Usage | null = null;
  let chunks = 0;

  for (;;) {
    if (options.signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      // AbortError or socket reset: keep what we already received.
      break;
    }
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return { text, usage, chunks };
      try {
        const frame = JSON.parse(data) as ChatCompletion;
        if (frame.usage) {
          usage = frame.usage;
          options.onUsage?.(frame.usage);
        }
        const delta = frame.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          chunks += 1;
          text += delta;
          options.onChunk?.({ delta, text, chunks });
        }
      } catch {
        continue;
      }
    }
  }
  return { text, usage, chunks };
}

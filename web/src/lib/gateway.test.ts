/**
 * GatewayClient: SSE parsing, abort semantics, evidence headers and error
 * mapping. Network is fully stubbed via `installFetch`; streams are built from
 * in-memory Response objects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayClient,
  GatewayError,
  evidenceFrom,
  resolveBaseUrl,
} from "@/lib/gateway";
import type { ChatPayload, StreamChunk, Usage } from "@/lib/types";
import { installFetch, jsonResponse, sseResponse } from "@/test/helpers";
import type { FetchMock } from "@/test/helpers";

const PAYLOAD: ChatPayload = {
  model: "gpt-5",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.7,
  stream: false,
};

const CHUNK_ONE = JSON.stringify({ choices: [{ delta: { content: "Hel" } }] });
const CHUNK_TWO = JSON.stringify({ choices: [{ delta: { content: "lo" } }] });
const USAGE_FRAME = JSON.stringify({
  choices: [],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
});

const EVIDENCE_HEADERS: Record<string, string> = {
  "x-request-id": "req-1",
  "x-lane": "registered",
  "x-key-id": "key-9",
  "x-provider": "openai",
  "x-cache": "MISS",
  "x-cache-hash": "abc123",
  "x-latency-ms": "42",
};

let fetchStub: FetchMock;

beforeEach(() => {
  fetchStub = installFetch([["/v1/chat/completions", () => sseResponse([], {})]]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveBaseUrl", () => {
  it("strips trailing slashes and keeps empty (same-origin) as-is", () => {
    expect(resolveBaseUrl("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(resolveBaseUrl("http://localhost:8080///")).toBe("http://localhost:8080");
    expect(resolveBaseUrl("")).toBe("");
  });
});

describe("chatStream SSE parsing", () => {
  it("accumulates content frames, usage, chunks and evidence", async () => {
    fetchStub.mockImplementation(() =>
      Promise.resolve(sseResponse([CHUNK_ONE, CHUNK_TWO, USAGE_FRAME, "[DONE]"], EVIDENCE_HEADERS)),
    );
    const client = new GatewayClient({ baseUrl: "", apiKey: "" });
    const deltas: string[] = [];
    const chunkSnapshots: StreamChunk[] = [];
    const usageCalls: Usage[] = [];

    const result = await client.chatStream(PAYLOAD, {
      requestId: "req-fixed",
      onChunk: (chunk) => {
        deltas.push(chunk.delta);
        chunkSnapshots.push(chunk);
      },
      onUsage: (usage) => usageCalls.push(usage),
    });

    expect(result.text).toBe("Hello");
    expect(result.chunks).toBe(2);
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(result.status).toBe(200);
    expect(result.aborted).toBe(false);
    expect(result.evidence.cache).toBe("MISS");
    expect(result.evidence.requestId).toBe("req-1");
    expect(result.evidence.cacheHash).toBe("abc123");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(chunkSnapshots.map((c) => c.chunks)).toEqual([1, 2]);
    expect(chunkSnapshots[1]?.text).toBe("Hello");
    expect(usageCalls).toEqual([{ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }]);

    const call = fetchStub.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("/v1/chat/completions");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["x-request-id"]).toBe("req-fixed");
    expect((init?.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect(JSON.parse(String(init?.body))).toEqual({ ...PAYLOAD, stream: true });
  });

  it("preserves the partial text on a mid-stream abort", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    fetchStub.mockImplementation(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(encoder.encode(`data: ${CHUNK_ONE}\n\n`));
                // Stays open, like a live SSE connection.
              },
            }),
            { status: 200, headers: EVIDENCE_HEADERS },
          ),
        ),
    );
    const client = new GatewayClient({ baseUrl: "", apiKey: "" });

    const result = await client.chatStream(PAYLOAD, {
      signal: controller.signal,
      onChunk: (chunk) => {
        if (chunk.chunks === 1) controller.abort();
      },
    });

    expect(result.text).toBe("Hel");
    expect(result.chunks).toBe(1);
    expect(result.aborted).toBe(true);
  });

  it("propagates an AbortError when the transport aborts before the response", async () => {
    fetchStub.mockImplementation(() =>
      Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
    );
    const client = new GatewayClient({ baseUrl: "", apiKey: "" });
    const controller = new AbortController();

    const promise = client.chatStream(PAYLOAD, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("chat non-200 responses", () => {
  it("maps a JSON error body to GatewayError with status, code and evidence", async () => {
    fetchStub.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests",
              request_id: "req-77",
              retry_after: 12,
            },
          },
          429,
          EVIDENCE_HEADERS,
        ),
      ),
    );
    const client = new GatewayClient({ baseUrl: "", apiKey: "" });

    const caught: unknown = await client.chat(PAYLOAD).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(GatewayError);
    const gatewayError = caught as GatewayError;
    expect(gatewayError.status).toBe(429);
    expect(gatewayError.code).toBe("RATE_LIMITED");
    expect(gatewayError.message).toBe("Too many requests");
    expect(gatewayError.retryAfter).toBe(12);
    expect(gatewayError.evidence?.cache).toBe("MISS");
  });

  it("falls back to a status message when the body is not JSON", async () => {
    fetchStub.mockImplementation(() => Promise.resolve(new Response("", { status: 502 })));
    const client = new GatewayClient({ baseUrl: "", apiKey: "" });

    const caught: unknown = await client.chat(PAYLOAD).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(GatewayError);
    const gatewayError = caught as GatewayError;
    expect(gatewayError.status).toBe(502);
    expect(gatewayError.code).toBeNull();
    expect(gatewayError.message).toBe("Gateway request failed with status 502");
  });
});

describe("evidenceFrom", () => {
  it("maps every evidence header", () => {
    const headers = new Headers({
      "x-request-id": "req-42",
      "x-lane": "registered",
      "x-key-id": "key-9",
      "x-provider": "openai",
      "x-cache": "SEMANTIC_HIT",
      "x-cache-hash": "abc123",
      "x-latency-ms": "42",
      "x-coalesced": "true",
      "x-semantic-similarity": "0.9375",
      "x-fallback": "false",
    });

    expect(evidenceFrom(headers)).toEqual({
      requestId: "req-42",
      lane: "registered",
      keyId: "key-9",
      provider: "openai",
      cache: "SEMANTIC_HIT",
      cacheHash: "abc123",
      latencyMs: 42,
      coalesced: true,
      semanticSimilarity: 0.9375,
      fallback: false,
    });
  });

  it("returns nulls when no evidence headers are present", () => {
    expect(evidenceFrom(new Headers())).toEqual({
      requestId: null,
      lane: null,
      keyId: null,
      provider: null,
      cache: null,
      cacheHash: null,
      latencyMs: null,
      coalesced: null,
      semanticSimilarity: null,
      fallback: null,
    });
  });

  it("rejects unknown verdicts/lanes and malformed numbers", () => {
    const evidence = evidenceFrom(
      new Headers({
        "x-cache": "MAYBE",
        "x-lane": "admin",
        "x-latency-ms": "not-a-number",
        "x-coalesced": "yes",
      }),
    );

    expect(evidence.cache).toBeNull();
    expect(evidence.lane).toBeNull();
    expect(evidence.latencyMs).toBeNull();
    expect(evidence.coalesced).toBe(false);
  });
});

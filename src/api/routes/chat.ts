// api/routes/chat.ts — HTTP only. No fetch, no provider SDK here (ISOLATION).
// Responsibilities: validate (STANDARDIZATION), timeout+abort wiring, SSE framing, error mapping.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CachedChatResponse, CacheRepository } from "../../cache/CacheRepository.js";
import { buildExactCacheKey } from "../../domain/normalize.js";
import type { ChatRequest, TokenUsage } from "../../domain/types.js";
import { GatewayError } from "../../domain/types.js";
import type { GatewayConfig } from "../../infrastructure/config.js";
import { toGatewayError } from "../../infrastructure/errors.js";
import { log } from "../../infrastructure/logger.js";
import type { ProviderAdapter } from "../../providers/ProviderAdapter.js";

const BodySchema = z.object({
  model: z.string().min(1, "model is required"),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1) }))
    .min(1, "messages must contain at least one message"),
  temperature: z.number().min(0).max(2).default(1.0),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
});

export function registerChatRoutes(app: FastifyInstance, provider: ProviderAdapter, cfg: GatewayConfig, cache?: CacheRepository): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    const start = Date.now();
    const requestId = (request.headers["x-request-id"] as string) || randomUUID();
    reply.header("x-request-id", requestId);

    // 1. STANDARDIZATION: validate before touching the provider (never pay for a bad request).
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      log({ request_id: requestId, provider: provider.name, status: 400, error_code: "invalid_request" });
      return reply.status(400).send({ error: { code: "invalid_request", message: msg, request_id: requestId } });
    }
    const req: ChatRequest = {
      model: parsed.data.model,
      messages: parsed.data.messages,
      temperature: parsed.data.temperature,
      max_tokens: parsed.data.max_tokens,
      stream: parsed.data.stream,
    };

    // D3: hash the canonical request for EVERY validated request and echo it as
    // x-cache-hash. This is the client's proof of why a call HIT or MISSED (and
    // for stream:BYPASS, the key it *would* have used). sha256 of canonical JSON
    // is cheap and opaque — the canonical body itself is never echoed.
    const { key: cacheKey, hash: cacheHash } = buildExactCacheKey(provider.name, req);
    reply.header("x-cache-hash", cacheHash);

    // 2. Timeout + client-abort share one AbortController (see docs/experiments/day01-provider-timeout.md).
    // NOTE: never use `request.raw 'close'` here — Node emits it when the request
    // body is fully read too, which aborted every upstream call at ~100ms (found live
    // with Gemini). The response socket is the correct signal: `writableEnded` is
    // false only if the client went away before we finished.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.upstreamTimeoutMs);
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) ctrl.abort(); // real client disconnect -> cancel upstream
    });
    let hijacked = false; // D2: did we take over the raw socket (stream path)?

    try {
      if (!req.stream) {
        const useCache = cfg.cacheEnabled && cache !== undefined;
        if (useCache) {
          try {
            const raw = await cache!.get(cacheKey);
            if (raw !== null) {
              try {
                const cached = JSON.parse(raw) as CachedChatResponse;
                if (typeof cached.content === "string" && typeof cached.model === "string") {
                  const latency = Date.now() - start;
                  reply.header("x-provider", provider.name);
                  reply.header("x-latency-ms", String(latency));
                  reply.header("x-cache", "HIT");
                  log({ request_id: requestId, provider: provider.name, status: 200, latency_ms: latency, stream: false, cache: "hit" });
                  return reply.send({
                    id: `cached-${Date.now()}`,
                    model: cached.model,
                    choices: [{ message: { role: "assistant", content: cached.content }, finish_reason: "stop" }],
                    usage: cached.usage,
                  });
                }
                throw new Error("bad shape");
              } catch {
                await cache!.del(cacheKey).catch(() => undefined);
                log({ request_id: requestId, provider: provider.name, cache: "malformed-evict" });
              }
            }
          } catch (err) {
            log({ request_id: requestId, provider: provider.name, cache: "lookup-failed-miss", error: (err as Error)?.message ?? String(err) });
          }
        }
        const out = await provider.chat(req, ctrl.signal);
        if (useCache) {
          const payload: CachedChatResponse = {
            content: out.content,
            model: out.model,
            usage: out.usage,
            cachedAt: new Date().toISOString(),
          };
          await cache!.set(cacheKey, JSON.stringify(payload), cfg.cacheTtlSec).catch((err: unknown) =>
            log({ request_id: requestId, provider: provider.name, cache: "write-failed", error: (err as Error)?.message ?? String(err) }),
          );
        }
        const latency = Date.now() - start;
        reply.header("x-provider", provider.name);
        reply.header("x-latency-ms", String(latency));
        reply.header("x-cache", useCache ? "MISS" : "DISABLED");
        log({ request_id: requestId, provider: provider.name, status: 200, latency_ms: latency, stream: false, cache: useCache ? "miss" : "disabled" });
        return reply.send({
          id: out.id,
          model: out.model,
          choices: [{ message: { role: "assistant", content: out.content }, finish_reason: "stop" }],
          usage: out.usage,
        });
      }

      // SSE path (D2): hijack so Fastify does not try to send its own response.
      // Headers are written on the FIRST chunk instead of up front, because:
      //  (a) x-latency-ms can then mean time-to-first-token, and
      //  (b) an upstream failure before the first token (429/timeout — the
      //      common case on the Gemini free tier) still returns a real JSON
      //      error status instead of a silent empty 200 stream.
      //      After hijack() Fastify sets reply.sent = true, so send() is
      //      unusable — the catch branch writes the raw JSON itself.
      hijacked = true;
      reply.hijack();
      const streamId = `chatcmpl-${Date.now()}`;
      const baseHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-request-id": requestId,
        "x-provider": provider.name,
        "x-cache": "BYPASS",
        "x-cache-hash": cacheHash, // D3: the key this stream bypassed
      };
      const alive = (): boolean => !reply.raw.destroyed && !reply.raw.writableEnded;
      const safeWrite = (frame: string): void => {
        try {
          if (alive()) reply.raw.write(frame);
        } catch { /* client went away mid-stream */ }
      };
      const writeHead = (): number => {
        const ttft = Date.now() - start;
        try {
          if (alive()) reply.raw.writeHead(200, { ...baseHeaders, "x-latency-ms": String(ttft) });
        } catch { /* socket died between the check and the write */ }
        return ttft;
      };

      let headWritten = false;
      let ttftMs = 0;
      let usage: TokenUsage | undefined;
      for await (const chunk of provider.chatStream(req, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        if (!headWritten) {
          ttftMs = writeHead();
          headWritten = true;
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.delta) {
          safeWrite(`data: ${JSON.stringify({ id: streamId, model: req.model, choices: [{ delta: { content: chunk.delta } }] })}\n\n`);
        }
      }
      if (!headWritten) {
        // Provider yielded nothing (empty stream): still owe the client a head.
        ttftMs = writeHead();
        headWritten = true;
      }
      // D1: terminal usage frame, so streamed replies carry real token numbers.
      if (usage) safeWrite(`data: ${JSON.stringify({ id: streamId, model: req.model, choices: [], usage })}\n\n`);
      safeWrite("data: [DONE]\n\n");
      try {
        if (headWritten && !reply.raw.writableEnded) reply.raw.end();
      } catch { /* already closed */ }
      log({
        request_id: requestId,
        provider: provider.name,
        status: 200,
        latency_ms: Date.now() - start,
        ttft_ms: ttftMs,
        stream: true,
        cache: "bypass",
        usage: usage ? "reported" : "absent",
      });
      return;
    } catch (err) {
      const gw = err instanceof GatewayError ? err : toGatewayError(provider.name, err);
      log({ request_id: requestId, provider: provider.name, status: gw.status, latency_ms: Date.now() - start, stream: req.stream, error_code: gw.code });
      if (reply.raw.headersSent) {
        // Mid-stream failure: the client already got 200, so the only honest
        // signal is closing the stream (the UI shows the partial text).
        try { reply.raw.end(); } catch { /* already closed */ }
        return reply;
      }
      if (hijacked) {
        // D2: failed before the first token -> deliver the real status JSON on
        // the raw socket (Fastify's send() is off-limits after hijack).
        const body = JSON.stringify({ error: { code: gw.code, message: gw.message, request_id: requestId } });
        try {
          if (!reply.raw.destroyed) {
            reply.raw.writeHead(gw.status, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(Buffer.byteLength(body)),
              "x-request-id": requestId,
              "x-provider": provider.name,
              "x-cache": "BYPASS",
              "x-cache-hash": cacheHash,
            });
            reply.raw.end(body);
          }
        } catch { /* socket already gone */ }
        return reply;
      }
      return reply.status(gw.status).send({ error: { code: gw.code, message: gw.message, request_id: requestId } });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/health", async () => ({ ok: true, provider: provider.name, cache: cache?.name ?? "none" }));
}

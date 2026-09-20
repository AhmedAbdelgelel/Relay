// api/routes/chat.ts — HTTP only. No fetch, no provider SDK here (ISOLATION).
// Responsibilities: validate (STANDARDIZATION), timeout+abort wiring, SSE framing, error mapping.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatRequest } from "../../domain/types.js";
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

export function registerChatRoutes(app: FastifyInstance, provider: ProviderAdapter, cfg: GatewayConfig): void {
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

    try {
      if (!req.stream) {
        const out = await provider.chat(req, ctrl.signal);
        const latency = Date.now() - start;
        reply.header("x-provider", provider.name);
        reply.header("x-latency-ms", String(latency));
        log({ request_id: requestId, provider: provider.name, status: 200, latency_ms: latency, stream: false });
        return reply.send({
          id: out.id,
          model: out.model,
          choices: [{ message: { role: "assistant", content: out.content }, finish_reason: "stop" }],
          usage: out.usage,
        });
      }

      // SSE path: hijack so Fastify does not try to send its own response.
      // Frame each provider chunk as `data: {...}` + terminal `data: [DONE]`.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-request-id": requestId,
        "x-provider": provider.name,
      });
      const streamId = `chatcmpl-${Date.now()}`;
      for await (const delta of provider.chatStream(req, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        reply.raw.write(`data: ${JSON.stringify({ id: streamId, model: req.model, choices: [{ delta: { content: delta } }] })}\n\n`);
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      log({ request_id: requestId, provider: provider.name, status: 200, latency_ms: Date.now() - start, stream: true });
      return;
    } catch (err) {
      const gw = err instanceof GatewayError ? err : toGatewayError(provider.name, err);
      log({ request_id: requestId, provider: provider.name, status: gw.status, latency_ms: Date.now() - start, stream: req.stream, error_code: gw.code });
      if (!reply.sent && !reply.raw.headersSent) {
        return reply.status(gw.status).send({ error: { code: gw.code, message: gw.message, request_id: requestId } });
      }
      try { reply.raw.end(); } catch { /* already closed */ }
      return reply;
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/health", async () => ({ ok: true, provider: provider.name }));
}

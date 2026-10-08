// HTTP only. No fetch, no provider SDK here (ISOLATION).
// Responsibilities: validate (STANDARDIZATION), timeout+abort wiring, SSE framing, error mapping.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CachedChatResponse, CacheRepository } from "../../cache/CacheRepository.js";
import type { SemanticCacheStore } from "../../cache/SemanticCacheStore.js";
import { SingleFlight } from "../../cache/SingleFlight.js";
import { buildExactCacheKey } from "../../domain/normalize.js";
import { normalizeChatContent, StreamingResponseNormalizer } from "../../domain/responseNormalizer.js";
import type { ChatRequest, ChatResponse, TokenUsage } from "../../domain/types.js";
import { GatewayError } from "../../domain/types.js";
import { promptTextForEmbedding, type EmbeddingProvider } from "../../embeddings/EmbeddingProvider.js";
import type { GatewayConfig } from "../../infrastructure/config.js";
import { toGatewayError } from "../../infrastructure/errors.js";
import { log } from "../../infrastructure/logger.js";
import { metrics } from "../../observability/metrics.js";
import { isReusableSemantic, systemFingerprint, POLICY_VERSION } from "../../policy/reuse.js";
import type { ProviderAdapter } from "../../providers/ProviderAdapter.js";
import { missingCapabilities } from "../../providers/capabilities.js";
import { providerForModel } from "../../providers/factory.js";
import { buildChain, executeChain, TargetBreaker, backoffDelayMs, sleepAbortable, DEFAULT_FALLBACK_POLICY } from "../../routing/fallback.js";

const BodySchema = z.object({
  model: z.string().min(1, "model is required"),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1) }))
    .min(1, "messages must contain at least one message"),
  temperature: z.number().min(0).max(2).default(1.0),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
});

export interface ChatRouteDeps {
  semanticStore?: SemanticCacheStore;
  embedder?: EmbeddingProvider;
  providers?: Map<string, ProviderAdapter>;
}

function tenantOf(request: { headers: Record<string, unknown> }): string {
  const raw = request.headers["x-tenant-id"];
  const t = (Array.isArray(raw) ? raw[0] : raw) as string | undefined;
  const trimmed = typeof t === "string" ? t.trim() : "";
  return trimmed || "default";
}

// Quota hint: providers often say when to retry ("Please retry in 7h33m58s",
// "retry in 12s", "retryDelay": "7s"). Surface it as error.retry_after so the
// UI can show a human hint instead of making the user dig through the message.
// Returns the raw duration token ("7h33m58s") or undefined when unparseable.
export function parseRetryAfter(message: string): string | undefined {
  const m = message.match(/retry\s*(?:in|after)?\s*:?\s*((?:\d+\.?\d*\s*h\s*)?(?:\d+\.?\d*\s*m(?!s)\s*)?(?:\d+\.?\d*\s*s)?)/i);
  if (m && m[1] && /[\dhms]/i.test(m[1]) && /\d/.test(m[1])) {
    const token = m[1].replace(/\s+/g, "");
    if (token) return token;
  }
  const delay = message.match(/retryDelay"?\s*:?\s*"?(\d+)\s*s/i);
  if (delay) return `${delay[1]}s`;
  return undefined;
}

export function registerChatRoutes(app: FastifyInstance, provider: ProviderAdapter, cfg: GatewayConfig, cache?: CacheRepository, deps: ChatRouteDeps = {}): void {
  // One flight table per app instance (test isolation). Keyed by
  // exact cacheKey, so different prompts/providers never coalesce.
  const flight = new SingleFlight<ChatResponse>();
  const breaker = new TargetBreaker();

  // JSON snapshot for operators/tests.
  app.get("/metrics", async () => metrics.snapshot());

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
    // Per-model routing: when a providers map is present, the model prefix
    // selects the adapter (gpt-* -> openai, claude-* -> anthropic, ...).
    // Otherwise use the single injected provider (backward compatible).
    const active: ProviderAdapter = deps.providers ? providerForModel(req.model, deps.providers, provider) : provider;

    // T8 capability gate: consult the selected adapter's declared feature set
    // BEFORE dispatch. An undeclared capability -> explicit 400, INV-1 holds
    // (provider never called, cache never touched — this sits inside the
    // validated branch, before lookups), and the failure is loud instead of a
    // silent adapter degradation.
    const missing = missingCapabilities(req, active.capabilities);
    if (missing.length > 0) {
      const msg = `provider '${active.name}' does not support: ${missing.join(", ")}`;
      log({ request_id: requestId, provider: active.name, status: 400, error_code: "unsupported_capability" });
      return reply.status(400).send({ error: { code: "unsupported_capability", message: msg, request_id: requestId } });
    }

    // D3: hash the canonical request for EVERY validated request and echo it as
    // x-cache-hash. This is the client's proof of why a call HIT or MISSED (and
    // for stream:BYPASS, the key it *would* have used). sha256 of canonical JSON
    // is cheap and opaque — the canonical body itself is never echoed.
    // Exact cache key embeds the ACTIVE provider name, so routing automatically
    // isolates cache entries + singleflight flights per provider.
    const { key: cacheKey, hash: cacheHash } = buildExactCacheKey(active.name, req);
    reply.header("x-cache-hash", cacheHash);

    // 2. Timeout + client-abort share one AbortController.
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
        metrics.inc("requests_total");
        const useCache = cfg.cacheEnabled && cache !== undefined;
        const chain = buildChain(active, deps.providers);
        // --- L1 exact lookup per chain target in order (serving-key isolation).
        // A hit on any target's key is served under that target's identity, so a
        // fallback answer admitted under its serving key is retrievable here.
        if (useCache) {
          for (const lt of chain) {
            if (!breaker.canUse(lt.name)) continue;
            const lookupKey = lt.adapter === active ? cacheKey : buildExactCacheKey(lt.adapter.name, req).key;
            const t0 = Date.now();
            try {
              const raw = await cache!.get(lookupKey);
              metrics.observeCacheLookup(Date.now() - t0);
              if (raw === null) continue;
              try {
                const cached = JSON.parse(raw) as CachedChatResponse;
                if (typeof cached.content !== "string" || typeof cached.model !== "string") throw new Error("bad shape");
                const latency = Date.now() - start;
                metrics.inc("exact_hits");
                const servingName = lt.adapter.name;
                reply.header("x-provider", servingName);
                reply.header("x-latency-ms", String(latency));
                reply.header("x-cache", "HIT");
                if (lt.adapter !== active) reply.header("x-fallback", "true");
                reply.header("x-coalesced", "false");
                log({ request_id: requestId, provider: servingName, status: 200, latency_ms: latency, stream: false, cache: "hit" });
                return reply.send({
                  id: `cached-${Date.now()}`,
                  model: cached.model,
                  choices: [{ message: { role: "assistant", content: cached.content }, finish_reason: "stop" }],
                  usage: cached.usage,
                });
              } catch {
                await cache!.del(lookupKey).catch(() => undefined);
                log({ request_id: requestId, provider: lt.adapter.name, cache: "malformed-evict" });
                continue;
              }
            } catch (err) {
              metrics.observeCacheLookup(Date.now() - t0);
              metrics.inc("cache_lookup_failed");
              log({ request_id: requestId, provider: lt.adapter.name, cache: "lookup-failed-miss", error: (err as Error)?.message ?? String(err) });
              break;
            }
          }
          metrics.inc("exact_misses");
        }
        // --- L2 semantic lookup (Exact MISS -> Semantic -> Policy).
        // Non-stream only, like exact. Degrades to MISS on any failure, never 5xx.
        // Modular monolith: api/ depends on ports only (SemanticCacheStore,
        // EmbeddingProvider) + pure policy/isReusableSemantic. No SDK here.
        const tenant = tenantOf(request);
        const useSemantic = cfg.semanticEnabled && deps.semanticStore !== undefined && deps.embedder !== undefined;
        let queryEmbedding: number[] | undefined;
        let queryText = "";
        if (useSemantic) {
          try {
            queryText = promptTextForEmbedding(req);
            queryEmbedding = await deps.embedder!.embed(queryText, ctrl.signal);
            const candidates = await deps.semanticStore!.findSimilar(
              queryEmbedding,
              { tenant, provider: active.name, model: req.model },
              { threshold: cfg.semanticThreshold, topK: cfg.semanticTopK },
            );
            for (const hit of candidates) {
              const decision = isReusableSemantic(req, hit, { provider: active.name, threshold: cfg.semanticThreshold, tenant });
              if (!decision.reusable) continue;
              const latency = Date.now() - start;
              metrics.inc("semantic_hits");
              metrics.observeSemanticScore(hit.similarity);
              await deps.semanticStore!.recordHit(hit.id).catch(() => undefined);
              reply.header("x-provider", active.name);
              reply.header("x-latency-ms", String(latency));
              reply.header("x-cache", "SEMANTIC_HIT");
              reply.header("x-semantic-similarity", hit.similarity.toFixed(4));
              reply.header("x-coalesced", "false");
              log({ request_id: requestId, provider: active.name, status: 200, latency_ms: latency, stream: false, cache: "semantic-hit", similarity: hit.similarity });
              return reply.send({
                id: `semcached-${Date.now()}`,
                model: req.model,
                choices: [{ message: { role: "assistant", content: hit.content }, finish_reason: "stop" }],
                usage: hit.usage,
              });
            }
            metrics.inc("semantic_misses");
          } catch (err) {
            metrics.inc("semantic_errors");
            log({ request_id: requestId, provider: active.name, cache: "semantic-failed-miss", error: (err as Error)?.message ?? String(err) });
            queryEmbedding = undefined;
          }
        }
        // Single-flight: N concurrent identical misses => 1 provider call.
        // Flight key = exact cacheKey (provider-scoped), so it works even when the
        // cache is DISABLED. Upstream runs on its own AbortController: a single
        // waiter disconnecting rejects only its own wait (awaitShared), never the
        // shared work. No await between has() and run() => flag is exact.
        const wasCoalesced = flight.has(cacheKey);
        let servingName = active.name;
        let didFallback = false;
        const shared = flight.run(cacheKey, async () => {
          metrics.inc("provider_requests");
          const pt0 = Date.now();
          const upstream = new AbortController();
          const upstreamTimer = setTimeout(() => upstream.abort(), cfg.upstreamTimeoutMs);
          try {
            const chained = await executeChain(chain, {
              breaker,
              signal: upstream.signal,
              onFallback: () => metrics.inc("fallback_count"),
              onBreakerOpen: () => metrics.inc("breaker_open"),
              onBreakerClose: () => metrics.inc("breaker_open", -1),
              call: (t, signal) => t.adapter.chat(req, signal ?? upstream.signal),
            });
            const serving = chained.serving.adapter;
            servingName = serving.name;
            didFallback = chained.fallback;
            const raw = chained.result;
            metrics.observeProviderLatency(Date.now() - pt0);
            // Response Processor: strip presentation markup
            // BEFORE the caches see it, so an exact hit and a semantic hit both
            // return the same clean text and stored blobs stay canonical.
            const out: ChatResponse = { ...raw, content: normalizeChatContent(raw.content) };
            const writeKey = chained.fallback ? buildExactCacheKey(serving.name, req).key : cacheKey;
            if (useCache && out.content.trim() !== "") {
              const payload: CachedChatResponse = {
                content: out.content,
                model: out.model,
                usage: out.usage,
                cachedAt: new Date().toISOString(),
              };
              await cache!.set(writeKey, JSON.stringify(payload), cfg.cacheTtlSec).catch((err: unknown) => {
                metrics.inc("cache_write_failed");
                log({ request_id: requestId, provider: serving.name, cache: "write-failed", error: (err as Error)?.message ?? String(err) });
              });
            }
            // --- Cache admission (semantic): store MISS responses for future reuse.
            // Best-effort: reuse lookup embedding when available to avoid a 2nd
            // embed call; failures never fail the request.
            if (useSemantic && typeof out.content === "string" && out.content.trim() !== "") {
              try {
                let embedding = queryEmbedding;
                if (!embedding) {
                  const text = queryText || promptTextForEmbedding(req);
                  embedding = await deps.embedder!.embed(text, upstream.signal);
                }
                await deps.semanticStore!.save({
                  tenant,
                  provider: servingName,
                  model: req.model,
                  promptHash: cacheHash,
                  promptText: queryText || promptTextForEmbedding(req),
                  temperature: req.temperature ?? 1.0,
                  maxTokens: req.max_tokens ?? undefined,
                  embedding,
                  content: out.content,
                  usage: out.usage,
                  ttlSeconds: cfg.semanticTtlSec,
                  systemFingerprint: systemFingerprint(req),
                  policyVersion: POLICY_VERSION,
                });
              } catch (err) {
                metrics.inc("semantic_errors");
                log({ request_id: requestId, provider: servingName, cache: "semantic-save-failed", error: (err as Error)?.message ?? String(err) });
              }
            }
            return out;
          } catch (err) {
            metrics.inc("provider_errors");
            throw err;
          } finally {
            clearTimeout(upstreamTimer);
          }
        });
        if (wasCoalesced) metrics.inc("singleflight_coalesced");
        else metrics.inc("singleflight_leaders");
        const out = await awaitShared(shared, ctrl.signal);
        const latency = Date.now() - start;
        reply.header("x-provider", servingName);
        reply.header("x-latency-ms", String(latency));
        reply.header("x-cache", useCache ? "MISS" : "DISABLED");
        reply.header("x-coalesced", wasCoalesced ? "true" : "false");
        if (didFallback) reply.header("x-fallback", "true");
        log({ request_id: requestId, provider: servingName, status: 200, latency_ms: latency, stream: false, cache: useCache ? "miss" : "disabled", coalesced: wasCoalesced });
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
      metrics.inc("requests_total");
      hijacked = true;
      reply.hijack();
      const streamId = `chatcmpl-${Date.now()}`;
      const baseHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-request-id": requestId,
        "x-provider": active.name,
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
      const normalizer = new StreamingResponseNormalizer();
      let servingName = active.name;
      let streamError: unknown;
      let attempted = false;
      let movedOn = false;
      for (const t of buildChain(active, deps.providers)) {
        if (!breaker.canUse(t.name)) continue;
        attempted = true;
        if (t.adapter !== active && !headWritten && !movedOn) {
          movedOn = true;
          servingName = t.adapter.name;
          baseHeaders["x-provider"] = t.adapter.name;
          baseHeaders["x-fallback"] = "true";
          metrics.inc("fallback_count");
        }
        let targetServed = false;
        for (let attempt = 0; ; attempt++) {
          try {
            for await (const chunk of t.adapter.chatStream(req, ctrl.signal)) {
              if (ctrl.signal.aborted) break;
              if (!headWritten) {
                ttftMs = writeHead();
                headWritten = true;
              }
              if (chunk.usage) usage = chunk.usage;
              if (chunk.delta) {
                const clean = normalizer.push(chunk.delta);
                if (clean) {
                  safeWrite(`data: ${JSON.stringify({ id: streamId, model: req.model, choices: [{ delta: { content: clean } }] })}\n\n`);
                }
              }
            }
            if (breaker.recordSuccess(t.name)) metrics.inc("breaker_open", -1);
            streamError = undefined;
            targetServed = true;
            break;
          } catch (err) {
            if (headWritten) {
              if (breaker.recordFailure(t.name)) metrics.inc("breaker_open");
              throw err;
            }
            if (ctrl.signal.aborted) throw err;
            const gw = err instanceof GatewayError ? err : toGatewayError(t.adapter.name, err);
            if (!gw.retryable || attempt >= DEFAULT_FALLBACK_POLICY.maxRetries) {
              if (breaker.recordFailure(t.name)) metrics.inc("breaker_open");
              streamError = err;
              break;
            }
            await sleepAbortable(backoffDelayMs(attempt, DEFAULT_FALLBACK_POLICY.baseDelayMs), ctrl.signal);
          }
        }
        if (targetServed) break;
      }
      if (!headWritten) {
        if (streamError !== undefined || !attempted) {
          throw streamError ?? new GatewayError(502, "provider_error", "all targets unavailable (breakers open).", false);
        }
        // Provider yielded nothing (empty stream): still owe the client a head.
        ttftMs = writeHead();
        headWritten = true;
      }
      const tail = normalizer.flush();
      if (tail) {
        safeWrite(`data: ${JSON.stringify({ id: streamId, model: req.model, choices: [{ delta: { content: tail } }] })}\n\n`);
      }
      // D1: terminal usage frame, so streamed replies carry real token numbers.
      if (usage) safeWrite(`data: ${JSON.stringify({ id: streamId, model: req.model, choices: [], usage })}\n\n`);
      safeWrite("data: [DONE]\n\n");
      try {
        if (headWritten && !reply.raw.writableEnded) reply.raw.end();
      } catch { /* already closed */ }
      log({
        request_id: requestId,
        provider: servingName,
        status: 200,
        latency_ms: Date.now() - start,
        ttft_ms: ttftMs,
        stream: true,
        cache: "bypass",
        usage: usage ? "reported" : "absent",
      });
      return;
    } catch (err) {
      const gw = err instanceof GatewayError ? err : toGatewayError(active.name, err);
      log({ request_id: requestId, provider: active.name, status: gw.status, latency_ms: Date.now() - start, stream: req.stream, error_code: gw.code });
      if (reply.raw.headersSent) {
        // Mid-stream failure: the client already got 200, so the only honest
        // signal is closing the stream (the UI shows the partial text).
        try { reply.raw.end(); } catch { /* already closed */ }
        return reply;
      }
      if (hijacked) {
        // D2: failed before the first token -> deliver the real status JSON on
        // the raw socket (Fastify's send() is off-limits after hijack).
        const retryAfter = gw.status === 429 ? parseRetryAfter(gw.message) : undefined;
        const body = JSON.stringify({ error: { code: gw.code, message: gw.message, request_id: requestId, ...(retryAfter ? { retry_after: retryAfter } : {}) } });
        try {
          if (!reply.raw.destroyed) {
            reply.raw.writeHead(gw.status, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(Buffer.byteLength(body)),
              "x-request-id": requestId,
              "x-provider": active.name,
              "x-cache": "BYPASS",
              "x-cache-hash": cacheHash,
            });
            reply.raw.end(body);
          }
        } catch { /* socket already gone */ }
        return reply;
      }
      const retryAfter = gw.status === 429 ? parseRetryAfter(gw.message) : undefined;
      return reply.status(gw.status).send({ error: { code: gw.code, message: gw.message, request_id: requestId, ...(retryAfter ? { retry_after: retryAfter } : {}) } });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/health", async () => ({
    ok: true,
    provider: provider.name,
    cache: cache?.name ?? "none",
    semantic: deps.semanticStore?.name ?? "none",
    embedder: deps.embedder?.name ?? "none",
    // Cache tuning, read-only: lets the control plane show the real policy the
    // gateway is running with instead of guessing. Contains no secrets.
    config: {
      cacheEnabled: cfg.cacheEnabled,
      cacheTtlSec: cfg.cacheTtlSec,
      semanticEnabled: cfg.semanticEnabled,
      semanticThreshold: cfg.semanticThreshold,
      semanticTopK: cfg.semanticTopK,
      semanticTtlSec: cfg.semanticTtlSec,
      upstreamTimeoutMs: cfg.upstreamTimeoutMs,
    },
  }));
}

// Waiter-side abort. Rejects only this waiter's wait; the shared
// upstream promise keeps running for the remaining followers.
function awaitShared<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new GatewayError(504, "gateway_timeout", "request aborted.", true),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new GatewayError(504, "gateway_timeout", "request aborted.", true));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

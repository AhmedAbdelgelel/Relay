"use client";

/**
 * Playground — send real requests through the gateway
 * (POST /v1/chat/completions), watch the cache evidence come back.
 *
 * Full parity with the legacy page (agent/ui-inventory.md §2.2) plus the
 * agreed fixes: semantic verdicts are first-class, lane/routing evidence is
 * surfaced, latency keeps ms precision, partial stream text survives aborts,
 * drafts survive route switches and every request lands in `lastIO` for the
 * Request Inspector.
 *
 * Determinism: nothing here reads wall-clock or crypto during render — live
 * values (performance.now, new Date, request ids) are produced in event
 * handlers, async callbacks and effects only.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Card, CardTitle } from "@/components/ui";
import {
  GatewayClient,
  GatewayError,
  newRequestId,
} from "@/lib/gateway";
import { buildPayload, canonicalizePayload } from "@/lib/canonical";
import { estimateTokens, formatWait } from "@/lib/format";
import { newId, useAppStore } from "@/lib/store";
import type {
  ChatMessage,
  ChatPayload,
  ChatPayloadMessage,
  Evidence,
  MessageMeta,
} from "@/lib/types";
import { providerDisplayLabel, providerPillLabel } from "@/components/playground/catalog";
import { type PlaygroundDraft, getDraft, setDraft } from "@/components/playground/draft";
import { RequestPanel } from "@/components/playground/RequestPanel";
import { Thread, type LiveState, type PendingState } from "@/components/playground/Thread";
import { ResponseMeta, type RunSummary } from "@/components/playground/ResponseMeta";
import { RequestTrace } from "@/components/playground/RequestTrace";
import { SessionPanel } from "@/components/playground/SessionPanel";

const EMPTY_NOTICE =
  "The provider returned an empty response — the model may have hit its limit.";

interface StreamingState {
  chatId: string;
  messageId: string;
  who: string;
  model: string;
  chunks: number;
  elapsedMs: number;
}

interface RunState {
  messageId: string;
  payload: ChatPayload;
}

interface RetryState {
  messageId: string;
  payload: ChatPayload;
}

interface TraceState {
  payload: ChatPayload | null;
  summary: RunSummary | null;
  running: boolean;
}

/* ── pure helpers (module scope) ─────────────────────────────────────────── */

function emptyEvidence(requestId: string | null): Evidence {
  return {
    requestId,
    lane: null,
    keyId: null,
    provider: null,
    cache: null,
    cacheHash: null,
    latencyMs: null,
    coalesced: null,
    semanticSimilarity: null,
    fallback: null,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Browser fallback when the provider reports no usage (legacy estimateUsage()). */
function estimateTokensFromPayload(
  payload: ChatPayload,
  text: string,
): { promptTokens: number; completionTokens: number; estimated: boolean } {
  const prompt = payload.messages.map((message) => message.content).join("\n");
  return {
    promptTokens: estimateTokens(prompt),
    completionTokens: estimateTokens(text),
    estimated: true,
  };
}

/**
 * Rebuild a payload from a stored canonical request (sorted keys, stream
 * excluded by design, so the stream flag is inferred from the message meta).
 * Returns null when the string does not round-trip — never fabricate a body.
 */
function payloadFromCanonical(
  canonical: string | undefined,
  stream: boolean,
): ChatPayload | null {
  if (!canonical) return null;
  try {
    const parsed: unknown = JSON.parse(canonical);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.model !== "string" || !Array.isArray(record.messages)) return null;
    const messages: ChatPayloadMessage[] = [];
    for (const item of record.messages) {
      if (item === null || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const role = entry.role;
      const content = entry.content;
      if (
        (role !== "system" && role !== "user" && role !== "assistant") ||
        typeof content !== "string"
      ) {
        return null;
      }
      messages.push({ role, content });
    }
    if (messages.length === 0) return null;
    const payload: ChatPayload = {
      model: record.model,
      messages,
      temperature: typeof record.temperature === "number" ? record.temperature : 1,
      stream,
    };
    if (typeof record.max_tokens === "number") payload.max_tokens = record.max_tokens;
    return payload;
  } catch {
    return null;
  }
}

function resolvePayload(message: ChatMessage | null, lastRun: RunState | null): ChatPayload | null {
  if (!message) return null;
  if (lastRun && lastRun.messageId === message.id) return lastRun.payload;
  return payloadFromCanonical(message.meta?.canonical, message.meta?.chunks !== undefined);
}

/* ── page ────────────────────────────────────────────────────────────────── */

export default function PlaygroundPage(): ReactNode {
  const {
    connection,
    activeChat,
    activeChatId,
    newChat,
    appendMessage,
    updateMessage,
    recordStats,
    setLastIO,
    stats,
  } = useAppStore();

  const [form, setForm] = useState<PlaygroundDraft>(() => ({ ...getDraft() }));
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingState & { chatId: string } | null>(null);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [evidenceById, setEvidenceById] = useState<Record<string, Evidence>>({});
  const [lastRun, setLastRun] = useState<RunState | null>(null);
  const [retry, setRetry] = useState<RetryState | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [trace, setTrace] = useState<TraceState | null>(null);

  const aborterRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  /* draft + derived values */

  const patchForm = (patch: Partial<PlaygroundDraft>): void => {
    const next = { ...form, ...patch };
    setForm(next);
    setDraft(next);
  };

  const selectionLabel = providerDisplayLabel(form.provider);
  const connectionKey = `${connection.baseUrl}\u0000${connection.apiKey}`;

  const messages = activeChat?.messages ?? [];
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastMessagePayload = resolvePayload(lastMessage, lastRun);
  const regenerateId =
    !running &&
    lastMessage !== null &&
    lastMessage.role === "assistant" &&
    lastMessage.kind !== "error" &&
    lastMessagePayload !== null
      ? lastMessage.id
      : null;
  const retryId = retry !== null && !running ? retry.messageId : null;

  const live: LiveState | null =
    streaming !== null && streaming.chatId === activeChatId
      ? {
          messageId: streaming.messageId,
          who: streaming.who,
          model: streaming.model,
          chunks: streaming.chunks,
          elapsedMs: streaming.elapsedMs,
        }
      : null;
  const pendingRow: PendingState | null = useMemo(
    () =>
      pending !== null && pending.chatId === activeChatId
        ? { who: pending.who, model: pending.model }
        : null,
    [pending, activeChatId],
  );

  const lastMessageText = lastMessage ? lastMessage.text : "";
  const liveChunks = streaming?.chunks ?? 0;

  // Keep the newest row in view while the thread grows (DOM-only effect).
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeChatId, messages.length, lastMessageText, liveChunks, pendingRow]);

  /* actions */

  const remember = (messageId: string, evidence: Evidence) => {
    setEvidenceById((prev) => ({ ...prev, [messageId]: evidence }));
  };

  const abort = () => {
    aborterRef.current?.abort();
  };

  const run = async (chatId: string, payload: ChatPayload): Promise<void> => {
    const controller = new AbortController();
    aborterRef.current = controller;
    setRunning(true);
    setPending(null);
    setStreaming(null);

    const client = new GatewayClient(connection);
    const canonical = canonicalizePayload(payload);
    const sentId = newRequestId();
    const streamed = payload.stream;
    const selectLabel = selectionLabel;
    const t0 = performance.now();
    setTrace({ payload, summary: null, running: true });
    if (streamed) setPending({ chatId, who: selectLabel, model: payload.model });

    let messageId: string | null = null;
    let ttftMs: number | null = null;

    const makeMeta = (args: {
      verdict: MessageMeta["verdict"];
      provider: string | null;
      model: string;
      latencyMs: number | null;
      ttftMs?: number;
      chunks?: number;
      promptTokens?: number;
      completionTokens?: number;
      estimated?: boolean;
      cacheHash?: string | null;
      requestId: string;
    }): MessageMeta => ({
      verdict: args.verdict,
      provider: args.provider,
      model: args.model,
      latencyMs: args.latencyMs,
      ttftMs: args.ttftMs,
      chunks: args.chunks,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      estimated: args.estimated,
      cacheHash: args.cacheHash ?? undefined,
      canonical,
      requestId: args.requestId,
      at: new Date().toISOString(),
    });

    const buildSummary = (args: {
      evidence: Evidence;
      latencyMs: number;
      model: string;
      chunks: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      estimated: boolean;
    }): RunSummary => ({
      requestId: args.evidence.requestId ?? sentId,
      model: args.model,
      provider: args.evidence.provider,
      verdict: args.evidence.cache,
      latencyMs: args.latencyMs,
      gwMs: args.evidence.latencyMs,
      ttftMs: args.evidence.ttftMs ?? null,
      chunks: args.chunks,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      estimated: args.estimated,
      at: new Date().toISOString(),
    });

    try {
      if (streamed) {
        const res = await client.chatStream(payload, {
          signal: controller.signal,
          requestId: sentId,
          onChunk: (chunk) => {
            const now = performance.now();
            if (ttftMs === null) ttftMs = now - t0;
            let id = messageId;
            if (id === null) {
              id = newId("m");
              messageId = id;
              appendMessage(chatId, {
                id,
                role: "assistant",
                kind: "normal",
                text: chunk.text,
              });
              setPending(null);
            } else {
              updateMessage(chatId, id, { text: chunk.text });
            }
            setStreaming({
              chatId,
              messageId: id,
              who: selectLabel,
              model: payload.model,
              chunks: chunk.chunks,
              elapsedMs: now - t0,
            });
          },
        });

        const latencyMs = performance.now() - t0;
        const evidence: Evidence = { ...res.evidence, ttftMs };

        if (res.aborted) {
          // Partial text survives (rough edge #8): keep the message, patch meta.
          const id = messageId ?? newId("m");
          const meta = makeMeta({
            verdict: evidence.cache,
            provider: evidence.provider,
            model: payload.model,
            latencyMs,
            ttftMs: ttftMs ?? undefined,
            chunks: res.chunks,
            cacheHash: evidence.cacheHash,
            requestId: evidence.requestId ?? sentId,
          });
          if (messageId === null) {
            appendMessage(chatId, { id, role: "assistant", kind: "normal", text: "Stopped.", meta });
          } else {
            updateMessage(chatId, messageId, { meta });
          }
          remember(id, evidence);
          setLastRun({ messageId: id, payload });
          recordStats(evidence, null, null, {
            error: "aborted",
            ttftMs: ttftMs ?? undefined,
            chunks: res.chunks,
          });
          setLastIO({
            payload,
            canonical,
            evidence,
            usage: res.usage,
            text: res.text,
            mode: "stream",
            error: "aborted",
          });
          return;
        }

        if (!res.text.trim()) {
          const id = messageId ?? newId("m");
          const usage = res.usage;
          const meta = makeMeta({
            verdict: evidence.cache,
            provider: evidence.provider,
            model: payload.model,
            latencyMs,
            ttftMs: ttftMs ?? undefined,
            chunks: res.chunks,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            estimated: false,
            cacheHash: evidence.cacheHash,
            requestId: evidence.requestId ?? sentId,
          });
          if (messageId === null) {
            appendMessage(chatId, { id, role: "assistant", kind: "notice", text: EMPTY_NOTICE, meta });
          } else {
            updateMessage(chatId, messageId, { kind: "notice", text: EMPTY_NOTICE, meta });
          }
          remember(id, evidence);
          recordStats(
            evidence,
            usage
              ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
              : null,
            latencyMs,
            { chunks: res.chunks, error: null },
          );
          setLastIO({
            payload,
            canonical,
            evidence,
            usage: res.usage,
            text: res.text,
            mode: "stream",
          });
          setSummary(
            buildSummary({
              evidence,
              latencyMs,
              model: payload.model,
              chunks: res.chunks,
              promptTokens: usage?.prompt_tokens ?? null,
              completionTokens: usage?.completion_tokens ?? null,
              estimated: false,
            }),
          );
          return;
        }

        // Normal streamed answer.
        const usage = res.usage;
        const tokens = usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              estimated: false,
            }
          : estimateTokensFromPayload(payload, res.text);
        const id = messageId ?? newId("m");
        const meta = makeMeta({
          verdict: evidence.cache,
          provider: evidence.provider,
          model: payload.model,
          latencyMs,
          ttftMs: ttftMs ?? undefined,
          chunks: res.chunks,
          promptTokens: tokens.promptTokens,
          completionTokens: tokens.completionTokens,
          estimated: tokens.estimated,
          cacheHash: evidence.cacheHash,
          requestId: evidence.requestId ?? sentId,
        });
        if (messageId === null) {
          appendMessage(chatId, { id, role: "assistant", kind: "normal", text: res.text, meta });
        } else {
          updateMessage(chatId, messageId, { text: res.text, meta });
        }
        remember(id, evidence);
        setLastRun({ messageId: id, payload });
        recordStats(evidence, tokens, latencyMs, {
          ttftMs: ttftMs ?? undefined,
          chunks: res.chunks,
        });
        setLastIO({
          payload,
          canonical,
          evidence,
          usage: res.usage,
          text: res.text,
          mode: "stream",
        });
        setSummary(
          buildSummary({
            evidence,
            latencyMs,
            model: payload.model,
            chunks: res.chunks,
            promptTokens: tokens.promptTokens,
            completionTokens: tokens.completionTokens,
            estimated: tokens.estimated,
          }),
        );
        return;
      }

      // JSON mode.
      const res = await client.chat(payload, { signal: controller.signal, requestId: sentId });
      const latencyMs = performance.now() - t0;
      const evidence = res.evidence;
      const reply = res.json.choices?.[0]?.message?.content ?? "";
      const usage = res.json.usage ?? null;
      const model = res.json.model ?? payload.model;

      if (!reply.trim()) {
        const id = newId("m");
        const meta = makeMeta({
          verdict: evidence.cache,
          provider: evidence.provider,
          model,
          latencyMs,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          estimated: false,
          cacheHash: evidence.cacheHash,
          requestId: evidence.requestId ?? sentId,
        });
        appendMessage(chatId, { id, role: "assistant", kind: "notice", text: EMPTY_NOTICE, meta });
        remember(id, evidence);
        recordStats(
          evidence,
          usage
            ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
            : null,
          latencyMs,
          { error: null },
        );
        setLastIO({
          payload,
          canonical,
          evidence,
          usage,
          text: reply,
          mode: "json",
        });
        setSummary(
          buildSummary({
            evidence,
            latencyMs,
            model,
            chunks: null,
            promptTokens: usage?.prompt_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            estimated: false,
          }),
        );
        return;
      }

      const tokens = usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            estimated: false,
          }
        : estimateTokensFromPayload(payload, reply);
      const id = newId("m");
      const meta = makeMeta({
        verdict: evidence.cache,
        provider: evidence.provider,
        model,
        latencyMs,
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        estimated: tokens.estimated,
        cacheHash: evidence.cacheHash,
        requestId: evidence.requestId ?? sentId,
      });
      appendMessage(chatId, { id, role: "assistant", kind: "normal", text: reply, meta });
      remember(id, evidence);
      setLastRun({ messageId: id, payload });
      recordStats(evidence, tokens, latencyMs, { error: null });
      setLastIO({
        payload,
        canonical,
        evidence,
        usage,
        text: reply,
        mode: "json",
      });
      setSummary(
        buildSummary({
          evidence,
          latencyMs,
          model,
          chunks: null,
          promptTokens: tokens.promptTokens,
          completionTokens: tokens.completionTokens,
          estimated: tokens.estimated,
        }),
      );
    } catch (error) {
      const latencyMs = performance.now() - t0;

      if (isAbortError(error) || controller.signal.aborted) {
        // Aborted before the first byte: no partial text to keep.
        const id = newId("m");
        appendMessage(chatId, {
          id,
          role: "assistant",
          kind: "normal",
          text: "Stopped.",
          meta: makeMeta({
            verdict: null,
            provider: null,
            model: payload.model,
            latencyMs,
            chunks: streamed ? 0 : undefined,
            requestId: sentId,
          }),
        });
        recordStats(null, null, null, { error: "aborted" });
        setLastIO({
          payload,
          canonical,
          evidence: emptyEvidence(sentId),
          usage: null,
          text: "",
          mode: streamed ? "stream" : "json",
          error: "aborted",
        });
      } else if (error instanceof GatewayError) {
        const evidence = error.evidence ?? emptyEvidence(sentId);
        const wait = formatWait(`${JSON.stringify(error.payload ?? {})} ${error.message}`);
        const quota = error.status === 429;
        const title = quota ? "Quota exhausted · 429" : `Request failed · ${error.status}`;
        const body = quota
          ? `Quota exhausted for ${payload.model}.${
              wait ? ` Retry window ~${wait} from now.` : ""
            } Your prompt is saved — hit Retry or switch models.`
          : error.message;
        const id = newId("m");
        const meta = makeMeta({
          verdict: evidence.cache,
          provider: evidence.provider,
          model: payload.model,
          latencyMs,
          chunks: streamed ? 0 : undefined,
          cacheHash: evidence.cacheHash,
          requestId: evidence.requestId ?? sentId,
        });
        appendMessage(chatId, {
          id,
          role: "assistant",
          kind: "error",
          text: `${title}\n${body}`,
          meta,
        });
        if (quota) setRetry({ messageId: id, payload });
        remember(id, evidence);
        recordStats(evidence, null, null, { error: error.message });
        setLastIO({
          payload,
          canonical,
          evidence,
          usage: null,
          text: "",
          mode: streamed ? "stream" : "json",
          error: error.message,
        });
      } else {
        // Gateway unreachable (network error): keep the legacy recovery copy.
        const message = error instanceof Error ? error.message : String(error);
        const id = newId("m");
        appendMessage(chatId, {
          id,
          role: "assistant",
          kind: "error",
          text: "Cannot reach the gateway\nStart it with npm run dev, then retry.",
          meta: makeMeta({
            verdict: null,
            provider: null,
            model: payload.model,
            latencyMs: null,
            requestId: sentId,
          }),
        });
        recordStats(null, null, null, { error: "gateway unreachable" });
        setLastIO({
          payload,
          canonical,
          evidence: emptyEvidence(sentId),
          usage: null,
          text: "",
          mode: streamed ? "stream" : "json",
          error: message,
        });
      }
    } finally {
      aborterRef.current = null;
      setRunning(false);
      setPending(null);
      setStreaming(null);
      setTrace((prev) => (prev ? { ...prev, running: false } : prev));
    }
  };

  const sendOrStop = (): void => {
    if (running) {
      abort();
      return;
    }
    const text = form.user.trim();
    if (!text) return;
    const chatId = activeChatId ?? newChat();
    const payload = buildPayload({
      model: form.model,
      system: form.system,
      user: text,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      stream: form.stream,
    });
    appendMessage(chatId, { id: newId("m"), role: "user", kind: "normal", text });
    patchForm({ user: "" });
    void run(chatId, payload);
  };

  const regenerate = (): void => {
    if (running || !activeChatId || lastMessagePayload === null) return;
    void run(activeChatId, lastMessagePayload);
  };

  const retryLast = (): void => {
    if (running || !activeChatId || retry === null) return;
    void run(activeChatId, retry.payload);
  };

  const pickSuggestion = (text: string): void => {
    patchForm({ user: text });
    composerRef.current?.focus();
  };

  return (
    <div className="page-enter mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-5 py-6 md:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold text-ink">Playground</h1>
          <p className="mt-1 text-[13px] text-ink-2">
            Send real requests through the gateway · POST /v1/chat/completions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="neutral" title="Provider selection">
            {providerPillLabel(form.provider)}
          </Badge>
          {summary ? (
            <span className="font-mono text-[11px] text-ink-3" title={summary.requestId}>
              {summary.requestId.slice(0, 8)}
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[390px_minmax(0,1fr)]">
        <RequestPanel
          form={form}
          onPatch={patchForm}
          running={running}
          onSendOrStop={sendOrStop}
          connectionKey={connectionKey}
          composerRef={composerRef}
        />

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col">
            <CardTitle>Response</CardTitle>
            <div
              ref={threadRef}
              aria-live="polite"
              aria-busy={running}
              aria-label="Conversation"
              className="flex max-h-[60dvh] min-h-[220px] flex-col gap-3 overflow-y-auto pr-1"
            >
              <Thread
                chat={activeChat}
                fallbackLabel={selectionLabel}
                live={live}
                pending={pendingRow}
                evidenceById={evidenceById}
                regenerateId={regenerateId}
                retryId={retryId}
                onRegenerate={regenerate}
                onRetry={retryLast}
                onPick={pickSuggestion}
              />
            </div>
          </Card>

          <ResponseMeta summary={summary} />

          <RequestTrace
            payload={trace?.payload ?? null}
            summary={trace?.summary ?? null}
            running={trace?.running ?? false}
            providerId={form.provider}
          />

          <SessionPanel stats={stats} />
        </div>
      </div>
    </div>
  );
}

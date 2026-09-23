// providers/OpenAICompatibleProvider.ts — STANDARDIZATION over the wire.
// Gemini, Ollama, and OpenAI all speak POST {model,messages} -> {choices[0].message}.
// Only baseURL/apiKey/model differ, so one class covers all three (see factory.ts).

import type { ChatRequest, ChatResponse, TokenUsage } from "../domain/types.js";
import { providerHttpError, toGatewayError } from "../infrastructure/errors.js";
import type { ProviderAdapter, StreamChunk } from "./ProviderAdapter.js";

export interface OpenAICompatibleOpts {
  name: string;
  baseURL: string; // no trailing slash, e.g. https://generativelanguage.googleapis.com/v1beta/openai
  apiKey: string; // empty for Ollama
  defaultModel: string;
}

interface OpenAIChatJson {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string }; delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: number | string; message?: string; status?: string };
}

function errorPayloadStatus(err: { code?: number | string; status?: string }): number {
  if (err.code === 429 || err.code === "RESOURCE_EXHAUSTED" || err.status === "RESOURCE_EXHAUSTED") return 429;
  if (err.code === 404 || err.status === "NOT_FOUND") return 404;
  if (typeof err.code === "number" && err.code >= 400 && err.code < 600) return err.code;
  return 502;
}

/** Missing/partial usage -> undefined so the caller can degrade to an estimate (never invent). */
function readUsage(u?: { prompt_tokens?: number; completion_tokens?: number }): TokenUsage | undefined {
  if (!u) return undefined;
  if (typeof u.prompt_tokens !== "number" && typeof u.completion_tokens !== "number") return undefined;
  return { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 };
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly name: string;
  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(opts: OpenAICompatibleOpts) {
    this.name = opts.name;
    this.baseURL = opts.baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    try {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: req.model || this.defaultModel,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
          stream: false,
        }),
      });
      if (!res.ok) throw providerHttpError(this.name, res.status, await res.text());
      const json = (await res.json()) as OpenAIChatJson;
      if (json.error) throw providerHttpError(this.name, errorPayloadStatus(json.error), json.error.message ?? "provider error");
      const content = json.choices?.[0]?.message?.content ?? "";
      return {
        id: json.id ?? `gen-${Date.now()}`,
        model: json.model ?? req.model,
        content,
        usage: json.usage
          ? { prompt_tokens: json.usage.prompt_tokens ?? 0, completion_tokens: json.usage.completion_tokens ?? 0 }
          : undefined,
      };
    } catch (err) {
      throw toGatewayError(this.name, err);
    }
  }

  private streamBody(req: ChatRequest, includeUsage: boolean): string {
    const body: Record<string, unknown> = {
      model: req.model || this.defaultModel,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: true,
    };
    // D1: standard OpenAI flag asking for a terminal usage frame, so streamed
    // replies carry real token numbers instead of a client-side guess.
    if (includeUsage) body["stream_options"] = { include_usage: true };
    return JSON.stringify(body);
  }

  private fetchStream(req: ChatRequest, signal: AbortSignal, includeUsage: boolean): Promise<Response> {
    return fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(), Accept: "text/event-stream" },
      signal,
      body: this.streamBody(req, includeUsage),
    });
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    let res: Response;
    try {
      res = await this.fetchStream(req, signal, true);
      if (!res.ok) {
        const bodyText = await res.text();
        // Some OpenAI-compatible backends reject stream_options outright
        // (400). Retry once without it: a nicer metric is not worth failing
        // the stream. If they still fail -> normal error mapping.
        const retryable = res.status === 400 && /stream_options/i.test(bodyText);
        if (retryable) {
          res = await this.fetchStream(req, signal, false);
          if (!res.ok) throw providerHttpError(this.name, res.status, await res.text());
        } else {
          throw providerHttpError(this.name, res.status, bodyText);
        }
      }
    } catch (err) {
      throw toGatewayError(this.name, err);
    }
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined);
          throw toGatewayError(this.name, Object.assign(new Error("aborted"), { name: "AbortError" }));
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") return;
          let json: OpenAIChatJson | null = null;
          try {
            json = JSON.parse(data) as OpenAIChatJson;
          } catch {
            continue;
          }
          if (json.error) throw providerHttpError(this.name, errorPayloadStatus(json.error), json.error.message ?? "provider error");
          const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
          const usage = readUsage(json.usage);
          // Usage often arrives on a final `choices: []` frame; a frame can
          // also carry both. Yield anything the client needs exactly once.
          if (delta || usage) yield { delta, ...(usage ? { usage } : {}) };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

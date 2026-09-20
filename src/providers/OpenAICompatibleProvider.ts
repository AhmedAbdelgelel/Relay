// providers/OpenAICompatibleProvider.ts — STANDARDIZATION over the wire.
// Gemini, Ollama, and OpenAI all speak POST {model,messages} -> {choices[0].message}.
// Only baseURL/apiKey/model differ, so one class covers all three (see factory.ts).

import type { ChatRequest, ChatResponse } from "../domain/types.js";
import { providerHttpError, toGatewayError } from "../infrastructure/errors.js";
import type { ProviderAdapter } from "./ProviderAdapter.js";

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

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    let res;
    try {
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(), Accept: "text/event-stream" },
        signal,
        body: JSON.stringify({
          model: req.model || this.defaultModel,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.max_tokens,
          stream: true,
        }),
      });
    } catch (err) {
      throw toGatewayError(this.name, err);
    }
    if (!res.ok) throw providerHttpError(this.name, res.status, await res.text());
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
          try {
            const json = JSON.parse(data) as OpenAIChatJson;
            const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
            if (delta) yield delta;
          } catch {
            // Skip malformed SSE line — never crash the stream on one bad chunk.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

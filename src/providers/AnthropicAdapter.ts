// providers/AnthropicAdapter.ts — Anthropic Messages API adapter.
// POST {base}/v1/messages with x-api-key + anthropic-version: 2023-06-01.
// Body: {model, max_tokens, temperature, system?, messages}. Maps system role
// out of messages. Response content blocks -> string. Usage
// input_tokens/output_tokens -> prompt/completion.

import type { ChatRequest, ChatResponse, TokenUsage } from "../domain/types.js";
import { providerHttpError, toGatewayError } from "../infrastructure/errors.js";
import type { ProviderAdapter, StreamChunk } from "./ProviderAdapter.js";

export interface AnthropicOpts {
  name?: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicChatJson {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
}

function contentToString(blocks?: AnthropicContentBlock[]): string {
  if (!blocks) return "";
  return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
}

function readUsage(u?: { input_tokens?: number; output_tokens?: number }): TokenUsage | undefined {
  if (!u) return undefined;
  if (typeof u.input_tokens !== "number" && typeof u.output_tokens !== "number") return undefined;
  return { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0 };
}

function toAnthropicBody(req: ChatRequest, defaultModel: string): Record<string, unknown> {
  const systemParts = req.messages.filter((m) => m.role === "system").map((m) => m.content);
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = {
    model: req.model || defaultModel,
    max_tokens: req.max_tokens ?? 1024,
    messages,
  };
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (systemParts.length > 0) body["system"] = systemParts.join("\n");
  return body;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name: string;
  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(opts: AnthropicOpts) {
    this.name = opts.name ?? "anthropic";
    this.baseURL = opts.baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      ...extra,
    };
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    try {
      const res = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify(toAnthropicBody(req, this.defaultModel)),
      });
      if (!res.ok) throw providerHttpError(this.name, res.status, await res.text());
      const json = (await res.json()) as AnthropicChatJson;
      if (json.error) throw providerHttpError(this.name, 502, json.error.message ?? "provider error");
      return {
        id: json.id ?? `gen-${Date.now()}`,
        model: json.model ?? req.model,
        content: contentToString(json.content),
        usage: readUsage(json.usage),
      };
    } catch (err) {
      throw toGatewayError(this.name, err);
    }
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this.headers({ Accept: "text/event-stream" }),
        signal,
        body: JSON.stringify({ ...toAnthropicBody(req, this.defaultModel), stream: true }),
      });
      if (!res.ok) throw providerHttpError(this.name, res.status, await res.text());
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
        let eventName = "";
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith("event:")) {
            eventName = t.slice(6).trim();
            continue;
          }
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (!data) continue;
          let json: AnthropicStreamEvent | null = null;
          try {
            json = JSON.parse(data) as AnthropicStreamEvent;
          } catch {
            continue;
          }
          const kind = json.type ?? eventName;
          if (kind === "content_block_delta") {
            const text = json.delta?.text ?? "";
            if (text) yield { delta: text };
          } else if (kind === "message_delta") {
            const usage = readUsage(json.usage);
            if (usage) yield { delta: "", usage };
          } else if (kind === "message_start") {
            // No text yet; ignore.
          } else if (kind === "error") {
            throw providerHttpError(this.name, 502, JSON.stringify(json).slice(0, 300));
          }
          eventName = "";
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

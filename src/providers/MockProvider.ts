// providers/MockProvider.ts — deterministic fake for tests + zero-setup dev.
// Supports delay + failure injection so timeout/abort paths are testable without a real LLM.

import type { ChatResponse } from "../domain/types.js";
import type { ChatRequest } from "../domain/types.js";
import { GatewayError } from "../domain/types.js";
import type { ProviderAdapter, StreamChunk } from "./ProviderAdapter.js";

export type MockFailure = "rate_limited" | "server_error" | null;

export class MockProvider implements ProviderAdapter {
  readonly name = "mock";
  private delayMs: number;
  private failure: MockFailure;

  constructor(opts: { delayMs?: number; failure?: MockFailure } = {}) {
    this.delayMs = opts.delayMs ?? 0;
    this.failure = opts.failure ?? null;
  }

  private async wait(signal: AbortSignal): Promise<void> {
    if (this.delayMs <= 0) {
      if (signal.aborted) throw new GatewayError(504, "gateway_timeout", "mock timed out or aborted.", true);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.delayMs);
      const onAbort = () => {
        clearTimeout(t);
        reject(new GatewayError(504, "gateway_timeout", "mock timed out or aborted.", true));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private maybeFail(): void {
    if (this.failure === "rate_limited") {
      throw new GatewayError(429, "provider_rate_limited", "mock rate limited.", true);
    }
    if (this.failure === "server_error") {
      throw new GatewayError(502, "provider_error", "mock upstream 500.", true);
    }
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    await this.wait(signal);
    this.maybeFail();
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    return {
      id: `mock-${Date.now()}`,
      model: req.model,
      content: `mock echo (${req.model}): ${last.slice(0, 200)}`,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    await this.wait(signal);
    this.maybeFail();
    // Yield 3 chunks so SSE framing + client-abort mid-stream are testable.
    for (const chunk of ["mock ", "stream ", `(${req.model})`]) {
      if (signal.aborted) throw new GatewayError(504, "gateway_timeout", "mock stream aborted.", true);
      yield { delta: chunk };
    }
    // Terminal usage-only frame, exactly like OpenAI with stream_options.include_usage.
    yield { delta: "", usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
}

// providers/ProviderAdapter.ts — ISOLATION boundary (Dependency Inversion).
// api/ only depends on this interface, never on fetch/SDK details.

import type { ChatRequest, ChatResponse, TokenUsage } from "../domain/types.js";

/**
 * One streamed piece of a response.
 * - `delta` is the next content text ("" on a usage-only frame).
 * - `usage` is present only on the frame(s) the provider reports token
 *   accounting on (OpenAI sends a final `choices: []` frame when
 *   `stream_options.include_usage` is set). Missing usage is legal: the
 *   gateway must degrade, never invent numbers.
 */
export interface StreamChunk {
  delta: string;
  usage?: TokenUsage;
}

/**
 * Feature set an adapter explicitly supports (T8). The HTTP layer consults
 * this BEFORE dispatch: a request needing an undeclared capability fails with
 * 400 unsupported_capability and the provider is never called. Keep in sync
 * with tests/contract/provider-conformance.test.ts — the conformance matrix
 * is the executable proof of these declarations.
 */
export interface ProviderCapabilities {
  /** chat() is implemented (every shipped adapter). */
  chat: boolean;
  /** chatStream() is implemented. */
  streaming: boolean;
  /** Accepts tool/function-call definitions in messages. */
  tools: boolean;
  /** Accepts response_format/json-mode directives. */
  json: boolean;
  /** Accepts system-role messages (native, or folded by the adapter). */
  systemMessages: boolean;
  /** Accepts max_tokens. `false` means the adapter drops/forbids it. */
  maxTokens: boolean;
}

export interface ProviderAdapter {
  readonly name: string;
  /** Declared feature set, consulted by the HTTP layer before dispatch (T8). */
  readonly capabilities: ProviderCapabilities;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

/**
 * T8 TRANSLATION TABLE — frozen contract, proven cell-by-cell by
 * tests/contract/provider-conformance.test.ts. Trim rules, defaults, and
 * system mapping per adapter. "Trimmed" = leading/trailing whitespace stripped
 * (inner whitespace significant; message ORDER is always significant).
 *
 * | aspect                | MockProvider        | OpenAICompatibleProvider        | AnthropicAdapter                  |
 * | --------------------- | ------------------- | ------------------------------- | --------------------------------- |
 * | body                  | in-process echo     | `{model,messages,temperature,max_tokens,stream}` (field omitted when absent) | `{model,max_tokens,temperature,messages}` (+`system`, `stream`) |
 * | content trim          | verbatim (echo)     | verbatim, passthrough           | verbatim, passthrough             |
 * | system mapping        | passed through as-is| passed through as-is            | ALL system msgs folded into native `system` (joined "\\n"); removed from messages |
 * | max_tokens default    | n/a (echo)          | omitted when undefined          | implicit 1024 when undefined      |
 * | usage mapping         | fixed 10/5 echo     | prompt_tokens/completion_tokens as reported; missing/absent -> undefined (never invented); partial usage defaults the missing side to 0 | input_tokens->prompt_tokens, output_tokens->completion_tokens; same absent/partial rule |
 * | usage in stream       | terminal frame      | terminal `choices:[]` frame via `stream_options.include_usage`; backend 400 on stream_options -> ONE retry without it | message_delta event |
 * | temperature default   | verbatim            | sent as-is (client default 1.0 validated upstream) | omitted when undefined; client default 1.0 validated upstream |
 * | error map             | GatewayError direct | 429->429, 401/403/404->502, 5xx->502, Abort->504, snippet<=300 chars | same |
 * | endpoint              | in-process          | `POST {base}/chat/completions`  | `POST {base}/v1/messages` + x-api-key + anthropic-version |
 */

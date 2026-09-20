// domain/types.ts — pure types only. No I/O, no imports from api/providers/infra.
// ISOLATION: nothing outside domain may leak provider-specific shapes in here.

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number; // default 1.0
  max_tokens?: number;
  stream: boolean; // default false
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Standardized error the HTTP layer understands. */
export class GatewayError extends Error {
  status: number;
  code: string;
  retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

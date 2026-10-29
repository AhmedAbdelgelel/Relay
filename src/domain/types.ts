
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens?: number;
  stream: boolean;
  /** Nucleus sampling probability mass (0..1]. Absent = provider default. */
  top_p?: number;
  /** Up to 4 stop sequences; a bare string and a 1-element array are equivalent. */
  stop?: string | string[];
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  usage?: TokenUsage;
}

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

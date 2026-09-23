// infrastructure/config.ts — STANDARDIZATION of all env parsing in one place.
// Nothing else reads process.env directly.

export type ProviderName = "mock" | "gemini" | "ollama" | "openai";

export interface GatewayConfig {
  port: number;
  provider: ProviderName;
  upstreamTimeoutMs: number;
  geminiApiKey: string;
  geminiModel: string;
  geminiBaseUrl: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  redisUrl: string;
  cacheTtlSec: number;
  cacheEnabled: boolean;
}

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const provider = (env["PROVIDER"] ?? "mock").toLowerCase() as ProviderName;
  if (!["mock", "gemini", "ollama", "openai"].includes(provider)) {
    throw new Error(`PROVIDER must be one of mock|gemini|ollama|openai, got "${provider}"`);
  }
  return {
    port: num("PORT", 3000),
    provider,
    upstreamTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 25000),
    geminiApiKey: str("GEMINI_API_KEY"),
    geminiModel: str("GEMINI_MODEL", "gemini-3.6-flash"),
    geminiBaseUrl: str("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai"),
    ollamaBaseUrl: str("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    ollamaModel: str("OLLAMA_MODEL", "llama3.1:8b"),
    openaiApiKey: str("OPENAI_API_KEY"),
    openaiBaseUrl: str("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    redisUrl: str("REDIS_URL"),
    cacheTtlSec: num("CACHE_TTL_S", 3600),
    cacheEnabled: bool("CACHE_ENABLED", true),
  };
}

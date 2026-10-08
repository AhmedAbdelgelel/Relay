// STANDARDIZATION of all env parsing in one place.
// Nothing else reads process.env directly.

export type ProviderName = "mock" | "gemini" | "ollama" | "openai" | "anthropic" | "openrouter";

export type EmbeddingProviderName = "mock" | "gemini" | "ollama";

export type SemanticStoreName = "memory" | "pgvector";

export interface SeedApiKey {
  tenant: string;
  provider: ProviderName;
  name: string;
  key: string;
}

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
  openaiModel: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  openRouterKey: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  redisUrl: string;
  cacheTtlSec: number;
  cacheEnabled: boolean;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  semanticEnabled: boolean;
  semanticThreshold: number;
  semanticTopK: number;
  semanticTtlSec: number;
  semanticStore: SemanticStoreName;
  databaseUrl: string;
  gatewayApiKeys: SeedApiKey[];
  credEncKey: string;
}

function str(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  return env[name] ?? fallback;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function frac(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

const PROVIDER_NAMES: ProviderName[] = ["mock", "gemini", "ollama", "openai", "anthropic", "openrouter"];

function seedApiKeys(raw: string): SeedApiKey[] {
  if (raw.trim() === "") return [];
  return raw.split(",").flatMap((entry) => {
    if (entry.trim() === "") return [];
    const parts = entry.split(":");
    if (parts.length < 4) {
      throw new Error(`GATEWAY_API_KEYS entry must be tenant:provider:name:key, got "${entry.trim()}"`);
    }
    const tenant = parts[0]!.trim();
    const provider = parts[1]!.trim().toLowerCase();
    const name = parts[2]!.trim();
    const key = parts.slice(3).join(":").trim();
    if (!tenant || !provider || !name || !key) {
      throw new Error(`GATEWAY_API_KEYS entry must be tenant:provider:name:key with no empty part, got "${entry.trim()}"`);
    }
    if (!(PROVIDER_NAMES as string[]).includes(provider)) {
      throw new Error(`GATEWAY_API_KEYS provider must be one of ${PROVIDER_NAMES.join("|")}, got "${provider}"`);
    }
    return [{ tenant, provider: provider as ProviderName, name, key }];
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const provider = (env["PROVIDER"] ?? "mock").toLowerCase() as ProviderName;
  if (!["mock", "gemini", "ollama", "openai", "anthropic", "openrouter"].includes(provider)) {
    throw new Error(`PROVIDER must be one of mock|gemini|ollama|openai|anthropic|openrouter, got "${provider}"`);
  }
  const embeddingProvider = (env["EMBEDDING_PROVIDER"] ?? "mock").toLowerCase() as EmbeddingProviderName;
  if (!["mock", "gemini", "ollama"].includes(embeddingProvider)) {
    throw new Error(`EMBEDDING_PROVIDER must be one of mock|gemini|ollama, got "${embeddingProvider}"`);
  }
  const semanticStore = (env["SEMANTIC_STORE"] ?? "memory").toLowerCase() as SemanticStoreName;
  if (!["memory", "pgvector"].includes(semanticStore)) {
    throw new Error(`SEMANTIC_STORE must be one of memory|pgvector, got "${semanticStore}"`);
  }
  const databaseUrl = str(env, "DATABASE_URL");
  const credEncKey = str(env, "CRED_ENC_KEY");
  if (databaseUrl && !credEncKey) {
    throw new Error("CRED_ENC_KEY is required when DATABASE_URL is set (provider keys are stored encrypted)");
  }
  return {
    port: num(env, "PORT", 3000),
    provider,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", 25000),
    geminiApiKey: str(env, "GEMINI_API_KEY"),
    geminiModel: str(env, "GEMINI_MODEL", "gemini-3.6-flash"),
    geminiBaseUrl: str(env, "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai"),
    ollamaBaseUrl: str(env, "OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    ollamaModel: str(env, "OLLAMA_MODEL", "llama3.1:8b"),
    openaiApiKey: str(env, "OPENAI_API_KEY"),
    openaiBaseUrl: str(env, "OPENAI_BASE_URL", "https://api.openai.com/v1"),
    openaiModel: str(env, "OPENAI_MODEL", "gpt-4o-mini"),
    anthropicApiKey: str(env, "ANTHROPIC_API_KEY"),
    anthropicBaseUrl: str(env, "ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
    anthropicModel: str(env, "ANTHROPIC_MODEL", "claude-4"),
    // OPEN_ROUTER_KEY is the variable name in the project .env; a key is only
    // required when PROVIDER=openrouter (free models otherwise need nothing).
    openRouterKey: str(env, "OPEN_ROUTER_KEY"),
    openRouterBaseUrl: str(env, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    openRouterModel: str(env, "OPENROUTER_MODEL", "nvidia/nemotron-3-super-120b-a12b:free"),
    redisUrl: str(env, "REDIS_URL"),
    cacheTtlSec: num(env, "CACHE_TTL_S", 3600),
    cacheEnabled: bool(env, "CACHE_ENABLED", true),
    embeddingProvider,
    embeddingModel: str(env, "EMBEDDING_MODEL"),
    semanticEnabled: bool(env, "SEMANTIC_ENABLED", true),
    semanticThreshold: frac(env, "SEMANTIC_THRESHOLD", 0.92),
    semanticTopK: num(env, "SEMANTIC_TOP_K", 3),
    semanticTtlSec: num(env, "SEMANTIC_TTL_S", 3600),
    semanticStore,
    databaseUrl,
    gatewayApiKeys: seedApiKeys(str(env, "GATEWAY_API_KEYS")),
    credEncKey,
  };
}

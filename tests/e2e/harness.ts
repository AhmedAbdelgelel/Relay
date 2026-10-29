
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatRoutes } from "../../src/api/routes/chat.js";
import { registerConnectionsRoutes } from "../../src/api/routes/connections.js";
import { registerPlayground } from "../../src/api/routes/playground.js";
import { registerProviderRoutes } from "../../src/api/routes/providers.js";
import { registerRegisterRoutes } from "../../src/api/routes/register.js";
import { registerUsageRoutes } from "../../src/api/routes/usage.js";
import type { ApiKeyStore } from "../../src/auth/ApiKeyStore.js";
import type { CredentialStore } from "../../src/auth/CredentialStore.js";
import { CredentialCipher } from "../../src/auth/credentialCipher.js";
import { InMemoryApiKeyStore } from "../../src/auth/InMemoryApiKeyStore.js";
import { InMemoryCredentialStore } from "../../src/auth/InMemoryCredentialStore.js";
import type { CacheRepository } from "../../src/cache/CacheRepository.js";
import { createCacheFromEnv } from "../../src/cache/factory.js";
import { InMemoryVectorStore } from "../../src/cache/InMemoryVectorStore.js";
import type { SemanticCacheStore, SemanticEntry, SemanticFilter, SemanticHit } from "../../src/cache/SemanticCacheStore.js";
import type { ChatRequest, ChatResponse } from "../../src/domain/types.js";
import { EMBEDDING_DIM, type EmbeddingProvider } from "../../src/embeddings/EmbeddingProvider.js";
import { createEmbedderFromEnv } from "../../src/embeddings/factory.js";
import { loadConfig, type GatewayConfig } from "../../src/infrastructure/config.js";
import type { ProviderAdapter, ProviderCapabilities, StreamChunk } from "../../src/providers/ProviderAdapter.js";
import { createProviderFromEnv } from "../../src/providers/factory.js";

export const TEST_ENV: Record<string, string> = {
  PROVIDER: "mock",
  CACHE_ENABLED: "true",
  CACHE_TTL_S: "3600",
  SEMANTIC_ENABLED: "true",
  SEMANTIC_STORE: "memory",
  SEMANTIC_THRESHOLD: "0.92",
  SEMANTIC_TOP_K: "3",
  SEMANTIC_TTL_S: "3600",
  EMBEDDING_PROVIDER: "mock",
  GATEWAY_API_KEYS: "",
  REDIS_URL: "",
  DATABASE_URL: "",
  CRED_ENC_KEY: "",
  UPSTREAM_TIMEOUT_MS: "2500",
  OPEN_ROUTER_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  SAVED_USD_PER_1K_TOKENS: "0",
  // Tests use loopback fake upstreams as tenant BYO URLs; the SSRF policy is
  // deny-by-default, so the harness opts in explicitly. Production defaults to
  // false (see ALLOW_PRIVATE_PROVIDER_URLS in .env.example).
  ALLOW_PRIVATE_PROVIDER_URLS: "1",
};

export function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export interface AppOptions {
    env?: Record<string, string | undefined>;
    provider?: ProviderAdapter;
    providers?: Map<string, ProviderAdapter>;
  cache?: CacheRepository;
    semanticStore?: SemanticCacheStore | null;
  embedder?: EmbeddingProvider;
  auth?: { apiKeys: ApiKeyStore; credentials: CredentialStore };
}

export interface BuiltApp {
  app: FastifyInstance;
  cfg: GatewayConfig;
  provider: ProviderAdapter;
  providers?: Map<string, ProviderAdapter>;
  cache: CacheRepository;
  semanticStore?: SemanticCacheStore;
  embedder?: EmbeddingProvider;
  auth: { apiKeys: ApiKeyStore; credentials: CredentialStore };
}

export function makeApp(opts: AppOptions = {}): BuiltApp {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 });
  const cfg = withEnv({ ...TEST_ENV, ...opts.env }, () => loadConfig());
  const provider = opts.provider ?? createProviderFromEnv(cfg);
  const providers = opts.providers;
  const cache = opts.cache ?? createCacheFromEnv(cfg);
  const semanticStore =
    opts.semanticStore === null
      ? undefined
      : opts.semanticStore ?? (cfg.semanticEnabled ? new InMemoryVectorStore() : undefined);
  const embedder = opts.embedder ?? (semanticStore ? createEmbedderFromEnv(cfg) : undefined);
  const auth = opts.auth ?? {
    apiKeys: new InMemoryApiKeyStore(cfg.gatewayApiKeys),
    credentials: new InMemoryCredentialStore(new CredentialCipher(cfg.credEncKey || "e2e-dev-secret")),
  };
  registerChatRoutes(app, provider, cfg, cache, { semanticStore, embedder, providers, auth });
  registerRegisterRoutes(app, cfg, auth);
  registerConnectionsRoutes(app, cfg, auth);
  registerUsageRoutes(app, auth);
  registerProviderRoutes(app, cfg, providers ?? new Map([[provider.name, provider]]));
  registerPlayground(app);
  return { app, cfg, provider, providers, cache, semanticStore, embedder, auth };
}

export async function chat(
  app: FastifyInstance,
  key: string | null,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const merged: Record<string, string> = { ...headers };
  if (key) merged["authorization"] = `Bearer ${key}`;
  return app.inject({ method: "POST", url: "/v1/chat/completions", headers: merged, payload: body });
}

export function json<T = Record<string, unknown>>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}

export function parseSSE(body: string): { frames: Record<string, unknown>[]; done: boolean } {
  const frames: Record<string, unknown>[] = [];
  let done = false;
  for (const block of body.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    frames.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return { frames, done };
}

export function joinedDeltas(frames: Record<string, unknown>[]): string {
  return frames
    .map((f) => {
      const choices = f["choices"] as { delta?: { content?: string } }[] | undefined;
      return choices?.[0]?.delta?.content ?? "";
    })
    .join("");
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

function blend(): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 0.8;
  v[1] = 0.6;
  return v;
}

export class KeywordEmbedder implements EmbeddingProvider {
  readonly name = "test-keyword";
  readonly dimension = EMBEDDING_DIM;
  calls = 0;
  async embed(text: string, _signal: AbortSignal): Promise<number[]> {
    this.calls++;
    const t = text.toLowerCase();
    if (t.includes("blend")) return blend();
    if (t.includes("gateway")) return unit(0);
    if (t.includes("recipe")) return unit(1);
    const j = Number(/junk(\d+)/.exec(t)?.[1] ?? 0);
    return unit(2 + j);
  }
}

export class LeakyVectorStore extends InMemoryVectorStore {
  private tenants = new Set<string>();
  override async save(entry: SemanticEntry): Promise<void> {
    this.tenants.add(entry.tenant);
    return super.save(entry);
  }
  override async findSimilar(embedding: number[], filter: SemanticFilter, opts: { threshold: number; topK: number }): Promise<SemanticHit[]> {
    const out: SemanticHit[] = [];
    for (const tenant of this.tenants) {
      out.push(...(await super.findSimilar(embedding, { ...filter, tenant }, opts)));
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, opts.topK);
  }
}

export interface ScriptedOpts {
  capabilities?: Partial<ProviderCapabilities>;
  configured?: boolean;
  chat?: (req: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>;
  stream?: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk>;
}

export class ScriptedProvider implements ProviderAdapter {
  readonly name: string;
  readonly configured: boolean;
  readonly capabilities: ProviderCapabilities;
  calls = 0;
  streamCalls = 0;
  requests: ChatRequest[] = [];
  private chatImpl: (req: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>;
  private streamImpl: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk>;

  constructor(name: string, opts: ScriptedOpts = {}) {
    this.name = name;
    this.configured = opts.configured ?? true;
    this.capabilities = {
      chat: true,
      streaming: true,
      tools: false,
      json: false,
      systemMessages: true,
      maxTokens: true,
      ...opts.capabilities,
    };
    this.chatImpl =
      opts.chat ??
      (async (req) => ({
        id: `scripted-${name}`,
        model: req.model,
        content: `scripted(${name}): ${req.messages[req.messages.length - 1]?.content ?? ""}`,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    this.streamImpl = opts.stream ?? defaultStream;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    this.calls++;
    this.requests.push(req);
    return this.chatImpl(req, signal);
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.streamCalls++;
    this.requests.push(req);
    yield* this.streamImpl(req, signal);
  }
}

async function* defaultStream(req: ChatRequest): AsyncIterable<StreamChunk> {
  yield { delta: `${req.model} ` };
  yield { delta: "stream " };
  yield { delta: "(e2e)" };
  yield { delta: "", usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

export interface UpstreamHit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeUpstream {
  url: string;
  hits: UpstreamHit[];
  close(): Promise<void>;
}

export async function startFakeUpstream(
  handler: (hit: UpstreamHit, res: ServerResponse) => void,
): Promise<FakeUpstream> {
  const hits: UpstreamHit[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = { _raw: raw };
      }
      const hit: UpstreamHit = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      handler(hit, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}



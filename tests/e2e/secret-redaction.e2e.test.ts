import { describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";
import { GatewayError } from "../../src/domain/types.js";
import { makeApp, ScriptedProvider } from "./harness.js";

/**
 * Secret-redaction keepers.
 *
 * The gateway must never echo back: seeded gateway keys (GATEWAY_API_KEYS),
 * provider credentials stored via register/connections, or passwords embedded
 * in DATABASE_URL/REDIS_URL/CRED_ENC_KEY, neither in HTTP bodies/headers nor
 * in the JSON log lines written through src/infrastructure/logger.ts.
 *
 * The only place a gateway key may appear is the 201 response that issued it
 * (shown once, by design).
 */

const SEEDED_GATEWAY_KEY = "lg_seededSECRETgatewaykey0001";
const SEEDED_GATEWAY_KEY_GEMINI = "lg_seededSECRETgemini0002";
const PROVIDER_CREDENTIAL = "sk-provider-SECRET-credential-0001";
const PROVIDER_CREDENTIAL_2 = "sk-provider-SECRET-second-0002";
const DB_PASSWORD = "db-SECRET-password-0001";
const REDIS_PASSWORD = "redis-SECRET-password-0001";
const CRED_ENC_KEY = "cred-enc-SECRET-key-0001";
const DATABASE_URL = `postgres://relay:${DB_PASSWORD}@127.0.0.1:5432/relay`;
const REDIS_URL = `redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0`;

const ENV = {
  GATEWAY_API_KEYS: `tenant1:mock:seed:${SEEDED_GATEWAY_KEY},tenant2:gemini:seed2:${SEEDED_GATEWAY_KEY_GEMINI}`,
  DATABASE_URL,
  CRED_ENC_KEY,
  REDIS_URL,
};

const SECRETS: Record<string, string> = {
  "seeded gateway key": SEEDED_GATEWAY_KEY,
  "seeded gemini gateway key": SEEDED_GATEWAY_KEY_GEMINI,
  "tenant provider credential": PROVIDER_CREDENTIAL,
  "second tenant provider credential": PROVIDER_CREDENTIAL_2,
  "DATABASE_URL password": DB_PASSWORD,
  "REDIS_URL password": REDIS_PASSWORD,
  CRED_ENC_KEY,
};

interface ConsoleCapture {
  lines: string[];
  restore(): void;
}

const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
};

function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const push = (args: unknown[]) => {
    lines.push(
      args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" "),
    );
  };
  console.log = (...args: unknown[]) => push(args);
  console.error = (...args: unknown[]) => push(args);
  console.warn = (...args: unknown[]) => push(args);
  return {
    lines,
    restore() {
      console.log = originalConsole.log;
      console.error = originalConsole.error;
      console.warn = originalConsole.warn;
    },
  };
}

type Captured = { label: string; text: string; status: number };

async function inject(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  options: { headers?: Record<string, string>; payload?: unknown; rawPayload?: string } = {},
): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let response;
  if (options.rawPayload !== undefined) {
    headers["content-type"] = "application/json";
    response = await app.inject({ method, url, headers, payload: options.rawPayload });
  } else if (options.payload !== undefined) {
    response = await app.inject({ method, url, headers, payload: options.payload as InjectOptions["payload"] });
  } else {
    response = await app.inject({ method, url, headers });
  }
  const responseHeaders: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(response.headers)) responseHeaders[name] = value;
  return { status: response.statusCode, text: response.body, headers: responseHeaders };
}

function assertNoSecrets(captured: Captured[], logs: string[], issuedKeys: string[]): void {
  const text = captured.map((entry) => entry.text).join("\n");
  const logText = logs.join("\n");
  for (const [label, secret] of Object.entries(SECRETS)) {
    expect(text, `HTTP surface leaked ${label}`).not.toContain(secret);
    expect(logText, `captured console log leaked ${label}`).not.toContain(secret);
  }
  for (const issued of issuedKeys) {
    // Issued keys are shown once in their 201 body only; they must not appear
    // on any other surface or in logs.
    expect(logText, "captured console log leaked an issued gateway key").not.toContain(issued);
    for (const entry of captured) {
      if (entry.label === "register-issued-key") continue;
      expect(entry.text, `HTTP surface ${entry.label} leaked an issued gateway key`).not.toContain(issued);
    }
  }
}

describe("secret redaction over HTTP and logs", () => {
  it("normal + failure paths never expose gateway keys, provider credentials, or URL/encryption passwords", async () => {
    const provider = new ScriptedProvider("mock");
    const normal = makeApp({ provider, cache: new InMemoryCache(), env: ENV });
    const capture = captureConsole();
    const captured: Captured[] = [];
    const issuedKeys: string[] = [];

    try {
      // --- normal surfaces -------------------------------------------------
      for (const [label, url] of [
        ["health", "/health"],
        ["providers", "/providers"],
        ["metrics", "/metrics"],
      ] as const) {
        const res = await inject(normal.app, "GET", url);
        captured.push({ label, status: res.status, text: res.text });
        expect(res.status).toBe(200);
      }

      const reg = await inject(normal.app, "POST", "/v1/register", {
        payload: { name: "redaction", provider: "mock", provider_key: PROVIDER_CREDENTIAL },
      });
      expect(reg.status).toBe(201);
      const issued = (JSON.parse(reg.text) as { key: string }).key;
      expect(issued).toMatch(/^lg_[A-Za-z0-9_-]{20,}$/);
      issuedKeys.push(issued);
      captured.push({ label: "register-issued-key", status: reg.status, text: reg.text });
      expect(reg.text).not.toContain(PROVIDER_CREDENTIAL);

      const auth = { authorization: `Bearer ${issued}` };
      const connect = await inject(normal.app, "POST", "/v1/connections", {
        headers: auth,
        payload: { provider: "mock", provider_key: PROVIDER_CREDENTIAL_2 },
      });
      expect(connect.status).toBe(201);
      captured.push({ label: "connections", status: connect.status, text: connect.text });

      const list = await inject(normal.app, "GET", "/v1/connections", { headers: auth });
      captured.push({ label: "connections-list", status: list.status, text: list.text });
      expect(list.status).toBe(200);
      // Metadata only: provider + base_url + endpoint + created_at, never the key.
      const connections = (JSON.parse(list.text) as { connections: Array<Record<string, unknown>> }).connections;
      expect(connections.length).toBeGreaterThan(0);
      for (const connection of connections) {
        expect(Object.keys(connection).sort()).toEqual(["base_url", "created_at", "endpoint", "provider"]);
        expect(JSON.stringify(connection)).not.toContain(PROVIDER_CREDENTIAL);
      }

      const usage = await inject(normal.app, "GET", "/v1/usage", { headers: auth });
      expect(usage.status).toBe(200);
      captured.push({ label: "usage", status: usage.status, text: usage.text });

      const chat = await inject(normal.app, "POST", "/v1/chat/completions", {
        headers: auth,
        payload: { model: "mock-model", messages: [{ role: "user", content: "redaction probe" }] },
      });
      expect(chat.status).toBe(200);
      captured.push({ label: "chat-normal", status: chat.status, text: chat.text });

      // --- failure paths ---------------------------------------------------
      const failures: Array<{ label: string; method: "GET" | "POST"; url: string; options?: Parameters<typeof inject>[3] }> = [
        { label: "chat-no-lane", method: "POST", url: "/v1/chat/completions", options: { payload: { model: "mock-model", messages: [{ role: "user", content: "x" }] } } },
        { label: "chat-bad-key", method: "POST", url: "/v1/chat/completions", options: { headers: { authorization: "Bearer lg_not_a_key" }, payload: { model: "mock-model", messages: [{ role: "user", content: "x" }] } } },
        { label: "chat-validation", method: "POST", url: "/v1/chat/completions", options: { headers: auth, payload: { messages: [] } } },
        { label: "chat-malformed-json", method: "POST", url: "/v1/chat/completions", options: { headers: auth, rawPayload: "{bad json" } },
        { label: "chat-provider-mismatch", method: "POST", url: "/v1/chat/completions", options: { headers: { authorization: `Bearer ${SEEDED_GATEWAY_KEY_GEMINI}` }, payload: { model: "mock-model", messages: [{ role: "user", content: "x" }] } } },
        { label: "connections-anonymous", method: "GET", url: "/v1/connections" },
        { label: "unknown-route", method: "GET", url: "/nope" },
      ];
      for (const failure of failures) {
        const res = await inject(normal.app, failure.method, failure.url, failure.options);
        captured.push({ label: failure.label, status: res.status, text: res.text });
        expect(res.status, failure.label).toBeGreaterThanOrEqual(400);
      }

      // Server-side provider failure (injected adapter): 502 error body/log must stay clean.
      const failingProvider = new ScriptedProvider("mock", {
        chat: async () => {
          throw new GatewayError(502, "provider_error", "upstream 500");
        },
      });
      const failing = makeApp({ provider: failingProvider, cache: new InMemoryCache(), env: ENV });
      const failingChat = await inject(failing.app, "POST", "/v1/chat/completions", {
        headers: { authorization: `Bearer ${SEEDED_GATEWAY_KEY}` },
        payload: { model: "mock-model", messages: [{ role: "user", content: "boom" }] },
      });
      captured.push({ label: "chat-provider-error", status: failingChat.status, text: failingChat.text });
      expect(failingChat.status).toBe(502);
      await failing.app.close();
    } finally {
      capture.restore();
      await normal.app.close();
    }

    assertNoSecrets(captured, capture.lines, issuedKeys);
  });

  it("read-only surfaces do not echo config secrets (DATABASE_URL/REDIS_URL/CRED_ENC_KEY/passwords)", async () => {
    const { app } = makeApp({
      cache: new InMemoryCache(),
      env: {
        DATABASE_URL: `postgres://relay:${DB_PASSWORD}@db.internal:5432/relay`,
        CRED_ENC_KEY,
        REDIS_URL: `redis://default:${REDIS_PASSWORD}@cache.internal:6379/3`,
      },
    });
    const capture = captureConsole();
    const captured: Captured[] = [];
    try {
      for (const [label, url] of [
        ["health", "/health"],
        ["providers", "/providers"],
        ["metrics", "/metrics"],
      ] as const) {
        const res = await inject(app, "GET", url);
        captured.push({ label, status: res.status, text: res.text });
        expect(res.status).toBe(200);
        expect(res.text).not.toMatch(/db\.internal|cache\.internal/);
      }
      // /health must not reveal the configured URLs either, only backend names.
      expect(captured.find((entry) => entry.label === "health")!.text).not.toContain("postgres://");
    } finally {
      capture.restore();
      await app.close();
    }
    const text = captured.map((entry) => entry.text).join("\n") + "\n" + capture.lines.join("\n");
    for (const secret of [DB_PASSWORD, REDIS_PASSWORD, CRED_ENC_KEY]) {
      expect(text).not.toContain(secret);
    }
  });

  it("provider error bodies redact known secrets instead of echoing upstream fragments", async () => {
    const operatorKey = "sk-live-OPERATOR-SECRET-0001";
    const provider = new ScriptedProvider("mock", {
      chat: async () => {
        throw new GatewayError(502, "provider_error", `provider rejected key: ${operatorKey}`);
      },
    });
    const { app } = makeApp({ provider, env: { ...ENV, OPENAI_API_KEY: operatorKey } });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${SEEDED_GATEWAY_KEY}` },
        payload: { model: "mock-model", messages: [{ role: "user", content: "redact me" }] },
      });
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(operatorKey);
      expect(res.body).toContain("[redacted]");
    } finally {
      await app.close();
    }
  });
});

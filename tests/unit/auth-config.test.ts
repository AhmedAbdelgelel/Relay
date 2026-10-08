import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/infrastructure/config.js";

function env(over: Record<string, string | undefined> = {}) {
  return {
    PROVIDER: "mock",
    EMBEDDING_PROVIDER: "mock",
    SEMANTIC_STORE: "memory",
    ...over,
  } as NodeJS.ProcessEnv;
}

describe("auth config (T1)", () => {
  it("empty seed parses to no keys", () => {
    expect(loadConfig(env()).gatewayApiKeys).toEqual([]);
    expect(loadConfig(env({ GATEWAY_API_KEYS: "   " })).gatewayApiKeys).toEqual([]);
  });

  it("parses single and multiple seed entries", () => {
    const c = loadConfig(env({ GATEWAY_API_KEYS: "acme:gemini:main:lg_abc, bob:openai:dev:lg_def" }));
    expect(c.gatewayApiKeys).toEqual([
      { tenant: "acme", provider: "gemini", name: "main", key: "lg_abc" },
      { tenant: "bob", provider: "openai", name: "dev", key: "lg_def" },
    ]);
  });

  it("trims whitespace and skips blank entries from stray commas", () => {
    const c = loadConfig(env({ GATEWAY_API_KEYS: " acme : gemini : main : lg_abc ,, " }));
    expect(c.gatewayApiKeys).toEqual([{ tenant: "acme", provider: "gemini", name: "main", key: "lg_abc" }]);
  });

  it("keeps provider keys that contain colons", () => {
    const c = loadConfig(env({ GATEWAY_API_KEYS: "acme:ollama:local:part1:part2:part3" }));
    expect(c.gatewayApiKeys).toEqual([{ tenant: "acme", provider: "ollama", name: "local", key: "part1:part2:part3" }]);
  });

  it("rejects entries with fewer than 4 parts", () => {
    expect(() => loadConfig(env({ GATEWAY_API_KEYS: "acme:gemini:main" }))).toThrow(/tenant:provider:name:key/);
  });

  it("rejects entries with an empty part", () => {
    expect(() => loadConfig(env({ GATEWAY_API_KEYS: "acme:gemini::lg_abc" }))).toThrow(/no empty part/);
    expect(() => loadConfig(env({ GATEWAY_API_KEYS: ":gemini:main:lg_abc" }))).toThrow(/no empty part/);
    expect(() => loadConfig(env({ GATEWAY_API_KEYS: "acme:gemini:main:  " }))).toThrow(/no empty part/);
  });

  it("rejects unknown providers in seed entries", () => {
    expect(() => loadConfig(env({ GATEWAY_API_KEYS: "acme:cohere:main:lg_abc" }))).toThrow(/provider must be one of/);
  });

  it("passes CRED_ENC_KEY through and requires it with DATABASE_URL", () => {
    expect(loadConfig(env()).credEncKey).toBe("");
    expect(loadConfig(env({ DATABASE_URL: "postgres://db/x", CRED_ENC_KEY: "s3cret" })).credEncKey).toBe("s3cret");
    expect(() => loadConfig(env({ DATABASE_URL: "postgres://db/x" }))).toThrow(/CRED_ENC_KEY/);
  });

  it("migration 002 creates both auth tables with the right constraints", () => {
    const sql = readFileSync(new URL("../../db/migrations/002_api_keys.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS api_keys");
    expect(sql).toContain("key_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS provider_credentials");
    expect(sql).toContain("PRIMARY KEY (tenant_id, provider)");
    expect(sql).not.toContain("scopes");
  });
});

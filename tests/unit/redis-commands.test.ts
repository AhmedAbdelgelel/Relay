// tests/unit/redis-commands.test.ts — RedisCache wire contract without a server.
//
// Parity with how other gateways test their Redis layer (e.g. LiteLLM asserting
// setex key/TTL wiring): every command the gateway issues is asserted for shape
// (key passthrough, EX + floored TTL with min 1). Fake client injected through
// the RedisCacheOpts.client seam; no network, deterministic.

import { describe, expect, it } from "vitest";
import { RedisCache, type RedisCommands } from "../../src/cache/RedisCache.js";

interface Call { cmd: string; args: unknown[] }

function fakeClient(over: Partial<RedisCommands> = {}): { client: RedisCommands; calls: Call[] } {
  const calls: Call[] = [];
  const client: RedisCommands = {
    status: "ready",
    on: () => undefined,
    connect: async () => undefined,
    get: async (key: string) => {
      calls.push({ cmd: "get", args: [key] });
      return "v";
    },
    set: async (key: string, value: string, mode: string, ttl: number) => {
      calls.push({ cmd: "set", args: [key, value, mode, ttl] });
      return "OK";
    },
    del: async (key: string) => {
      calls.push({ cmd: "del", args: [key] });
      return 1;
    },
    ping: async () => {
      calls.push({ cmd: "ping", args: [] });
      return "PONG";
    },
    disconnect: () => {
      calls.push({ cmd: "disconnect", args: [] });
    },
    ...over,
  };
  return { client, calls };
}

describe("RedisCache command shape (no server)", () => {
  it("set issues EX with floored TTL, minimum 1 (LiteLLM setex parity)", async () => {
    const { client, calls } = fakeClient();
    const cache = new RedisCache({ url: "redis://unused:6379", client });
    await cache.set("llm:exact:v1:mock:abc", "payload", 3600.7);
    expect(calls).toEqual([{ cmd: "set", args: ["llm:exact:v1:mock:abc", "payload", "EX", 3600] }]);
    await cache.set("k", "v", 0.2);
    expect(calls[1]).toEqual({ cmd: "set", args: ["k", "v", "EX", 1] });
  });

  it("get/del pass keys through untouched", async () => {
    const { client, calls } = fakeClient();
    const cache = new RedisCache({ url: "redis://unused:6379", client });
    await expect(cache.get("llm:exact:v1:mock:abc")).resolves.toBe("v");
    await cache.del("llm:exact:v1:mock:abc");
    expect(calls).toEqual([
      { cmd: "get", args: ["llm:exact:v1:mock:abc"] },
      { cmd: "del", args: ["llm:exact:v1:mock:abc"] },
    ]);
  });

  it("ping maps PONG->true and failure->false (never throws)", async () => {
    const ok = fakeClient();
    const cacheOk = new RedisCache({ url: "redis://unused:6379", client: ok.client });
    await expect(cacheOk.ping()).resolves.toBe(true);
    const down = fakeClient({ ping: async () => { throw new Error("down"); } });
    const cacheDown = new RedisCache({ url: "redis://unused:6379", client: down.client });
    await expect(cacheDown.ping()).resolves.toBe(false);
  });

  it("close disconnects without throwing", async () => {
    const { client, calls } = fakeClient();
    const cache = new RedisCache({ url: "redis://unused:6379", client });
    await cache.close();
    expect(calls).toEqual([{ cmd: "disconnect", args: [] }]);
  });
});

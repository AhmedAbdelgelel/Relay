import { describe, expect, it } from "vitest";
import { InMemoryCache } from "../../src/cache/InMemoryCache.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("InMemoryCache eviction + TTL (Day 12 unit)", () => {
  it("expires entries after TTL", async () => {
    const c = new InMemoryCache();
    await c.set("k", "v", 1);
    expect(await c.get("k")).toBe("v");
    await sleep(1100);
    expect(await c.get("k")).toBeNull();
  });

  it("caps size and evicts oldest-first", async () => {
    const c = new InMemoryCache({ maxEntries: 3 });
    await c.set("a", "1", 60);
    await c.set("b", "2", 60);
    await c.set("c", "3", 60);
    await c.set("d", "4", 60); // evicts "a"
    expect(c.size).toBe(3);
    expect(await c.get("a")).toBeNull();
    expect(await c.get("d")).toBe("4");
  });

  it("get refreshes LRU recency", async () => {
    const c = new InMemoryCache({ maxEntries: 2 });
    await c.set("a", "1", 60);
    await c.set("b", "2", 60);
    expect(await c.get("a")).toBe("1"); // "a" now most-recent
    await c.set("c", "3", 60); // evicts "b"
    expect(await c.get("b")).toBeNull();
    expect(await c.get("a")).toBe("1");
    expect(await c.get("c")).toBe("3");
  });

  it("overwrite does not grow the map", async () => {
    const c = new InMemoryCache({ maxEntries: 2 });
    await c.set("a", "1", 60);
    await c.set("a", "2", 60);
    expect(c.size).toBe(1);
    expect(await c.get("a")).toBe("2");
  });
});

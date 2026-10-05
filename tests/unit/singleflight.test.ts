import { describe, expect, it } from "vitest";
import { SingleFlight } from "../../src/cache/SingleFlight.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe("SingleFlight (Day 10 unit)", () => {
  it("coalesces concurrent runs into one execution", async () => {
    const f = new SingleFlight<string>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await tick();
      return "ok";
    };
    const results = await Promise.all([f.run("k", fn), f.run("k", fn), f.run("k", fn)]);
    expect(results).toEqual(["ok", "ok", "ok"]);
    expect(calls).toBe(1);
    expect(f.coalesced).toBe(2);
    expect(f.leaders).toBe(1);
  });

  it("different keys run independently", async () => {
    const f = new SingleFlight<string>();
    let calls = 0;
    const fn = (v: string) => async () => {
      calls++;
      await tick();
      return v;
    };
    const [a, b] = await Promise.all([f.run("a", fn("A")), f.run("b", fn("B"))]);
    expect([a, b]).toEqual(["A", "B"]);
    expect(calls).toBe(2);
  });

  it("failures propagate to all waiters but never poison the next call", async () => {
    const f = new SingleFlight<string>();
    let calls = 0;
    const fail = async () => {
      calls++;
      await tick();
      throw new Error("boom");
    };
    await expect(Promise.all([f.run("k", fail), f.run("k", fail)])).rejects.toThrow("boom");
    expect(calls).toBe(1);
    // Map entry cleared: next call retries.
    const ok = await f.run("k", async () => "recovered");
    expect(ok).toBe("recovered");
    expect(calls).toBe(1); // fail counted once above; ok path uses inline fn (no increment)
  });

  it("sync throw does not poison the map", async () => {
    const f = new SingleFlight<string>();
    const throwing = () => {
      throw new Error("sync");
    };
    await expect(f.run("k", throwing as () => Promise<string>)).rejects.toThrow("sync");
    expect(f.has("k")).toBe(false);
    await expect(f.run("k", async () => "fine")).resolves.toBe("fine");
  });

  it("entry is removed after success so later calls re-execute", async () => {
    const f = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => ++calls;
    expect(await f.run("k", fn)).toBe(1);
    expect(await f.run("k", fn)).toBe(2);
    expect(f.has("k")).toBe(false);
  });
});

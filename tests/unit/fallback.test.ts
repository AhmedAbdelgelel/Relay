import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/domain/types.js";
import type { ProviderAdapter } from "../../src/providers/ProviderAdapter.js";
import {
  DEFAULT_FALLBACK_POLICY,
  TargetBreaker,
  backoffDelayMs,
  buildChain,
  executeChain,
  sleepAbortable,
} from "../../src/routing/fallback.js";
import type { FallbackPolicy, FallbackTarget } from "../../src/routing/fallback.js";

function fakeAdapter(name: string): ProviderAdapter {
  return {
    name,
    capabilities: { chat: true, streaming: true, tools: false, json: false, systemMessages: true, maxTokens: true },
    chat: async () => ({ id: "id", model: "m", content: "hi" }),
    chatStream: async function* () {
      yield { delta: "x" };
    },
  };
}

function target(name: string): FallbackTarget {
  return { name, adapter: fakeAdapter(name) };
}

function tiny(over: Partial<FallbackPolicy> = {}): FallbackPolicy {
  return { maxRetries: 2, baseDelayMs: 2, breakerFailures: 10, breakerCooldownMs: 1000, ...over };
}

const retryable = (msg = "boom") => new GatewayError(502, "provider_error", msg, true);
const fatal = (msg = "dead") => new GatewayError(502, "provider_not_found", msg, false);

describe("fallback", () => {
  describe("buildChain", () => {
    it("returns just the primary when no map is given", () => {
      const primary = fakeAdapter("p");
      const chain = buildChain(primary);
      expect(chain).toHaveLength(1);
      expect(chain[0]!.name).toBe("p");
      expect(chain[0]!.adapter).toBe(primary);
    });

    it("places the primary first, then the rest in map order", () => {
      const primary = fakeAdapter("p");
      const all = new Map([
        ["s1", fakeAdapter("s1")],
        ["s2", fakeAdapter("s2")],
      ]);
      const chain = buildChain(primary, all);
      expect(chain.map((t) => t.name)).toEqual(["p", "s1", "s2"]);
    });

    it("skips map entries that reuse the primary name", () => {
      const primary = fakeAdapter("p");
      const all = new Map([
        ["p", fakeAdapter("p-other")],
        ["s", fakeAdapter("s")],
      ]);
      const chain = buildChain(primary, all);
      expect(chain.map((t) => t.name)).toEqual(["p", "s"]);
      expect(chain[0]!.adapter).toBe(primary);
    });

    it("dedupes by adapter identity across different names", () => {
      const primary = fakeAdapter("p");
      const shared = fakeAdapter("shared");
      const all = new Map([
        ["s1", shared],
        ["s1-alias", shared],
        ["s2", fakeAdapter("s2")],
      ]);
      const chain = buildChain(primary, all);
      expect(chain.map((t) => t.name)).toEqual(["p", "s1", "s2"]);
    });
  });

  describe("DEFAULT_FALLBACK_POLICY", () => {
    it("matches the specified retry, backoff, and breaker defaults", () => {
      expect(DEFAULT_FALLBACK_POLICY).toEqual({
        maxRetries: 2,
        baseDelayMs: 100,
        breakerFailures: 3,
        breakerCooldownMs: 30000,
      });
    });
  });

  describe("backoffDelayMs", () => {
    it("attempt 0 stays within [0, base]", () => {
      expect(backoffDelayMs(0, 100, () => 0)).toBe(0);
      expect(backoffDelayMs(0, 100, () => 0.9999999)).toBe(100);
    });

    it("attempt 2 stays within [0, 4 * base]", () => {
      expect(backoffDelayMs(2, 100, () => 0)).toBe(0);
      expect(backoffDelayMs(2, 100, () => 0.9999999)).toBe(400);
    });

    it("samples never leave [0, cap]", () => {
      for (let attempt = 0; attempt <= 3; attempt++) {
        const cap = 100 * 2 ** attempt;
        for (let i = 0; i < 200; i++) {
          const d = backoffDelayMs(attempt, 100);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(cap);
        }
      }
    });

    it("spreads distinct delays across distinct draws", () => {
      const draws = [0, 0.2, 0.4, 0.6, 0.8, 0.9999999];
      const delays = draws.map((r) => backoffDelayMs(1, 100, () => r));
      expect(new Set(delays).size).toBe(draws.length);
    });
  });

  describe("sleepAbortable", () => {
    it("resolves immediately for zero or negative delays", async () => {
      await expect(sleepAbortable(0)).resolves.toBeUndefined();
      await expect(sleepAbortable(-3)).resolves.toBeUndefined();
      await expect(sleepAbortable(0, new AbortController().signal)).resolves.toBeUndefined();
    });

    it("rejects 504 when the signal is already aborted", async () => {
      const ctl = new AbortController();
      ctl.abort();
      const err = await sleepAbortable(20, ctl.signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(504);
    });

    it("rejects 504 when abort fires mid-sleep", async () => {
      const ctl = new AbortController();
      const pending = sleepAbortable(500, ctl.signal);
      setTimeout(() => ctl.abort(), 5);
      const err = await pending.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(504);
    });
  });

  describe("TargetBreaker", () => {
    it("opens after N consecutive failures and skips while open", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 3, breakerCooldownMs: 1000 }), () => nowMs);
      expect(b.recordFailure("a")).toBe(false);
      expect(b.canUse("a")).toBe(true);
      expect(b.recordFailure("a")).toBe(false);
      expect(b.canUse("a")).toBe(true);
      expect(b.recordFailure("a")).toBe(true);
      expect(b.canUse("a")).toBe(false);
      expect(b.openCount()).toBe(1);
      nowMs += 999;
      expect(b.canUse("a")).toBe(false);
    });

    it("admits one half-open probe once the cooldown elapses", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 1, breakerCooldownMs: 1000 }), () => nowMs);
      expect(b.recordFailure("a")).toBe(true);
      expect(b.canUse("a")).toBe(false);
      nowMs += 1000;
      expect(b.canUse("a")).toBe(true);
    });

    it("closes the breaker when the half-open probe succeeds", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 1, breakerCooldownMs: 1000 }), () => nowMs);
      b.recordFailure("a");
      nowMs += 1000;
      expect(b.canUse("a")).toBe(true);
      expect(b.recordSuccess("a")).toBe(true);
      expect(b.openCount()).toBe(0);
      expect(b.canUse("a")).toBe(true);
    });

    it("reopens silently when the half-open probe fails (no double-count)", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 1, breakerCooldownMs: 1000 }), () => nowMs);
      expect(b.recordFailure("a")).toBe(true);
      nowMs += 1000;
      expect(b.canUse("a")).toBe(true);
      expect(b.recordFailure("a")).toBe(false);
      expect(b.canUse("a")).toBe(false);
      expect(b.openCount()).toBe(1);
      nowMs += 1000;
      expect(b.canUse("a")).toBe(true);
    });

    it("resets the consecutive count on success", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 3, breakerCooldownMs: 1000 }), () => nowMs);
      b.recordFailure("a");
      b.recordFailure("a");
      expect(b.recordSuccess("a")).toBe(false);
      b.recordFailure("a");
      b.recordFailure("a");
      expect(b.canUse("a")).toBe(true);
      expect(b.recordFailure("a")).toBe(true);
      expect(b.canUse("a")).toBe(false);
    });

    it("tracks open targets independently", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 1, breakerCooldownMs: 1000 }), () => nowMs);
      expect(b.openCount()).toBe(0);
      b.recordFailure("a");
      b.recordFailure("b");
      expect(b.openCount()).toBe(2);
      b.recordSuccess("a");
      expect(b.openCount()).toBe(1);
      expect(b.canUse("a")).toBe(true);
      expect(b.canUse("b")).toBe(false);
    });

    it("reports newly-opened versus already-open on failure", () => {
      let nowMs = 0;
      const b = new TargetBreaker(tiny({ breakerFailures: 1, breakerCooldownMs: 1000 }), () => nowMs);
      expect(b.recordSuccess("fresh")).toBe(false);
      expect(b.recordFailure("a")).toBe(true);
      expect(b.recordFailure("a")).toBe(false);
    });
  });

  describe("executeChain", () => {
    it("succeeds on the first try with one attempt and no fallback", async () => {
      const policy = tiny();
      const breaker = new TargetBreaker(policy, () => 0);
      let calls = 0;
      let fallbackCalls = 0;
      const r = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        onAttempt: () => calls++,
        onFallback: () => fallbackCalls++,
        call: async () => "ok",
      });
      expect(r.result).toBe("ok");
      expect(r.serving.name).toBe("p");
      expect(r.fallback).toBe(false);
      expect(r.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(fallbackCalls).toBe(0);
    });

    it("retries a retryable error twice, then succeeds on attempt 3", async () => {
      const policy = tiny({ maxRetries: 2, baseDelayMs: 2 });
      const breaker = new TargetBreaker(policy, () => 0);
      let calls = 0;
      const r = await executeChain([target("p")], {
        breaker,
        policy,
        call: async () => {
          calls++;
          if (calls <= 2) throw retryable(`down-${calls}`);
          return "recovered";
        },
      });
      expect(r.result).toBe("recovered");
      expect(r.serving.name).toBe("p");
      expect(r.fallback).toBe(false);
      expect(r.attempts).toBe(3);
      expect(calls).toBe(3);
    });

    it("fails a non-retryable target over after exactly one attempt with no sleep", async () => {
      const policy = tiny({ maxRetries: 2, baseDelayMs: 1000 });
      const breaker = new TargetBreaker(policy, () => 0);
      let primaryCalls = 0;
      let fallbackFrom = "";
      let fallbackTo = "";
      const started = Date.now();
      const r = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        onFallback: (from, to) => {
          fallbackFrom = from;
          fallbackTo = to;
        },
        call: async (t) => {
          if (t.name === "p") {
            primaryCalls++;
            throw fatal();
          }
          return "via-fallback";
        },
      });
      expect(Date.now() - started).toBeLessThan(500);
      expect(r.result).toBe("via-fallback");
      expect(r.serving.name).toBe("s");
      expect(r.fallback).toBe(true);
      expect(r.attempts).toBe(2);
      expect(primaryCalls).toBe(1);
      expect(fallbackFrom).toBe("p");
      expect(fallbackTo).toBe("s");
    });

    it("exhausts bounded retries on the primary before failing over", async () => {
      const policy = tiny({ maxRetries: 1, baseDelayMs: 1 });
      const breaker = new TargetBreaker(policy, () => 0);
      let primaryCalls = 0;
      const r = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        call: async (t) => {
          if (t.name === "p") {
            primaryCalls++;
            throw retryable();
          }
          return "saved";
        },
      });
      expect(r.result).toBe("saved");
      expect(r.serving.name).toBe("s");
      expect(r.fallback).toBe(true);
      expect(r.attempts).toBe(3);
      expect(primaryCalls).toBe(2);
    });

    it("throws a GatewayError when every target fails", async () => {
      const policy = tiny({ maxRetries: 0 });
      const breaker = new TargetBreaker(policy, () => 0);
      let attempts = 0;
      const err = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        onAttempt: () => attempts++,
        call: async (t) => {
          throw retryable(`${t.name}-down`);
        },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(502);
      expect(attempts).toBe(2);
    });

    it("throws 502 without any call when breakers skip every target", async () => {
      const policy = tiny({ breakerFailures: 1 });
      const nowMs = 0;
      const breaker = new TargetBreaker(policy, () => nowMs);
      breaker.recordFailure("p");
      breaker.recordFailure("s");
      let calls = 0;
      const err = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        call: async () => {
          calls++;
          return "unreached";
        },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(502);
      expect((err as GatewayError).code).toBe("provider_error");
      expect(calls).toBe(0);
    });

    it("throws 502 for an empty chain", async () => {
      const policy = tiny();
      const breaker = new TargetBreaker(policy, () => 0);
      const err = await executeChain([], {
        breaker,
        policy,
        call: async () => "unreached",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(502);
    });

    it("rejects promptly on an already-aborted signal without any attempt", async () => {
      const policy = tiny();
      const breaker = new TargetBreaker(policy, () => 0);
      const ctl = new AbortController();
      ctl.abort();
      let calls = 0;
      let attempts = 0;
      const err = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        signal: ctl.signal,
        onAttempt: () => attempts++,
        call: async () => {
          calls++;
          return "unreached";
        },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(504);
      expect(calls).toBe(0);
      expect(attempts).toBe(0);
    });

    it("aborts a signal-aware call without touching the next target", async () => {
      const policy = tiny({ maxRetries: 2, baseDelayMs: 2 });
      const breaker = new TargetBreaker(policy, () => 0);
      const ctl = new AbortController();
      let secondaryCalls = 0;
      setTimeout(() => ctl.abort(), 5);
      const err = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        signal: ctl.signal,
        call: async (t, signal) => {
          if (t.name === "s") {
            secondaryCalls++;
            return "unreached";
          }
          await sleepAbortable(500, signal);
          throw retryable();
        },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(504);
      expect(secondaryCalls).toBe(0);
    });

    it("fires onBreakerOpen when a target trips", async () => {
      const policy = tiny({ maxRetries: 0, breakerFailures: 1 });
      const breaker = new TargetBreaker(policy, () => 0);
      let opened = 0;
      const r = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        onBreakerOpen: () => opened++,
        call: async (t) => {
          if (t.name === "p") throw fatal();
          return "saved";
        },
      });
      expect(r.serving.name).toBe("s");
      expect(opened).toBe(1);
      expect(breaker.canUse("p")).toBe(false);
    });

    it("closes the breaker and fires onBreakerClose on a half-open probe success", async () => {
      const policy = tiny({ maxRetries: 0, breakerFailures: 1, breakerCooldownMs: 1000 });
      let nowMs = 0;
      const breaker = new TargetBreaker(policy, () => nowMs);
      breaker.recordFailure("s");
      nowMs += 1000;
      let closed = 0;
      const r = await executeChain([target("p"), target("s")], {
        breaker,
        policy,
        onBreakerClose: () => closed++,
        call: async (t) => {
          if (t.name === "p") throw fatal();
          return "probed";
        },
      });
      expect(r.result).toBe("probed");
      expect(r.serving.name).toBe("s");
      expect(closed).toBe(1);
      expect(breaker.openCount()).toBe(1);
      expect(breaker.canUse("s")).toBe(true);
    });
  });

  describe("error precedence", () => {
    it("all-down surfaces the LAST target's error (failover convention)", async () => {
      const breaker = new TargetBreaker(tiny({ maxRetries: 0, breakerFailures: 10 }));
      const err = await executeChain([target("p"), target("s")], {
        breaker,
        policy: tiny({ maxRetries: 0, breakerFailures: 10 }),
        call: async (t) => {
          if (t.name === "p") throw fatal("primary config broken");
          throw retryable("fallback overloaded");
        },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect(err.message).toBe("fallback overloaded");
    });
  });
});

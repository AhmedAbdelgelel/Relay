// routing/fallback.ts — ordered retry/failover chain + per-target breaker (T14).
// Runs INSIDE the single-flight flight: coalescing is preserved, one chain per
// shared miss. No HTTP here; the route supplies targets + the call function.

import { GatewayError } from "../domain/types.js";
import { toGatewayError } from "../infrastructure/errors.js";
import type { ProviderAdapter } from "../providers/ProviderAdapter.js";

export interface FallbackTarget {
  name: string;
  adapter: ProviderAdapter;
}

export interface FallbackPolicy {
  maxRetries: number;
  baseDelayMs: number;
  breakerFailures: number;
  breakerCooldownMs: number;
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  maxRetries: 2,
  baseDelayMs: 100,
  breakerFailures: 3,
  breakerCooldownMs: 30000,
};

/** Chain order: routed primary first, then the other configured adapters. */
export function buildChain(primary: ProviderAdapter, all?: Map<string, ProviderAdapter>): FallbackTarget[] {
  const chain: FallbackTarget[] = [{ name: primary.name, adapter: primary }];
  if (!all) return chain;
  for (const [name, adapter] of all) {
    if (name !== primary.name && !chain.some((t) => t.adapter === adapter)) {
      chain.push({ name, adapter });
    }
  }
  return chain;
}

/** Full-jitter backoff for retry attempt n (0-based): uniform [0, base*2^n]. */
export function backoffDelayMs(attempt: number, baseDelayMs: number, rand: () => number = Math.random): number {
  const cap = baseDelayMs * 2 ** attempt;
  return Math.floor(rand() * (cap + 1));
}

function abortedError(): GatewayError {
  return new GatewayError(504, "gateway_timeout", "request aborted.", true);
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return reject(abortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TargetBreaker {
  private failures = new Map<string, number>();
  private openedAt = new Map<string, number>();
  private halfOpen = new Set<string>();

  constructor(
    private policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
    private now: () => number = Date.now,
  ) {}

  canUse(name: string): boolean {
    const at = this.openedAt.get(name);
    if (at === undefined) return true;
    if (this.now() - at >= this.policy.breakerCooldownMs) {
      this.openedAt.delete(name);
      this.halfOpen.add(name);
      return true;
    }
    return false;
  }

  recordSuccess(name: string): boolean {
    const was = this.openedAt.has(name) || this.halfOpen.has(name);
    this.failures.delete(name);
    this.openedAt.delete(name);
    this.halfOpen.delete(name);
    return was;
  }

  /** Returns true only on a newly counted open (closed -> open). A failed
   * half-open probe re-opens silently (returns false) so open-count gauges
   * increment exactly once per open breaker. */
  recordFailure(name: string): boolean {
    if (this.halfOpen.has(name)) {
      this.halfOpen.delete(name);
      this.failures.delete(name);
      this.openedAt.set(name, this.now());
      return false;
    }
    if (this.openedAt.has(name)) return false;
    const n = (this.failures.get(name) ?? 0) + 1;
    if (n >= this.policy.breakerFailures) {
      this.failures.delete(name);
      this.openedAt.set(name, this.now());
      return true;
    }
    this.failures.set(name, n);
    return false;
  }

  openCount(): number {
    return this.openedAt.size;
  }
}

export interface ChainResult<T> {
  result: T;
  serving: FallbackTarget;
  fallback: boolean;
  attempts: number;
}

export interface ChainOpts<T> {
  breaker: TargetBreaker;
  policy?: FallbackPolicy;
  signal?: AbortSignal;
  onAttempt?: () => void;
  onFallback?: (from: string, to: string) => void;
  onBreakerOpen?: () => void;
  onBreakerClose?: () => void;
  call: (target: FallbackTarget, signal?: AbortSignal) => Promise<T>;
}

export async function executeChain<T>(targets: FallbackTarget[], opts: ChainOpts<T>): Promise<ChainResult<T>> {
  const policy = opts.policy ?? DEFAULT_FALLBACK_POLICY;
  if (targets.length === 0) {
    throw new GatewayError(502, "provider_error", "no serving target available.", false);
  }
  let lastError: GatewayError | undefined;
  let attempts = 0;
  let movedOn = false;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (!opts.breaker.canUse(t.name)) continue;
    if (i > 0 && !movedOn) {
      movedOn = true;
      opts.onFallback?.(targets[0]!.name, t.name);
    }
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw abortedError();
      attempts++;
      opts.onAttempt?.();
      try {
        const result = await opts.call(t, opts.signal);
        if (opts.breaker.recordSuccess(t.name)) opts.onBreakerClose?.();
        return { result, serving: t, fallback: i > 0, attempts };
      } catch (err) {
        const gw = err instanceof GatewayError ? err : toGatewayError(t.name, err);
        if (opts.signal?.aborted) throw abortedError();
        if (!gw.retryable || attempt >= policy.maxRetries) {
          if (opts.breaker.recordFailure(t.name)) opts.onBreakerOpen?.();
          lastError = gw;
          break;
        }
        await sleepAbortable(backoffDelayMs(attempt, policy.baseDelayMs), opts.signal);
      }
    }
  }
  throw lastError ?? new GatewayError(502, "provider_error", "all targets unavailable (breakers open).", false);
}

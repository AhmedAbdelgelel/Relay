// Stampede protection for concurrent identical misses.
// Single-process only. One shared promise per key; followers await the leader.
// Upstream work is DETACHED from any single waiter's AbortSignal so one client
// disconnect cannot cancel the result for the other 99. A waiter abort only
// rejects that waiter's wait (see chat.ts awaitShared); upstream keeps its own
// timeout and always cleans the map entry on settle (success or failure).
// Failures are never cached: rejections propagate to all current waiters and
// the key is removed so the next request retries the provider.

export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();
  /** Total follower coalescings since construction (for metrics/tests). */
  coalesced = 0;
  /** Total leader executions since construction. */
  leaders = 0;

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  get size(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.inflight.clear();
  }

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.coalesced++;
      return existing;
    }
    this.leaders++;
    let p: Promise<T>;
    try {
      p = fn();
    } catch (err) {
      // Synchronous throw: never poison the map.
      return Promise.reject(err);
    }
    const tracked = p.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    return tracked;
  }
}

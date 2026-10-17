
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();
  coalesced = 0;
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
      return Promise.reject(err);
    }
    const tracked = p.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    return tracked;
  }
}

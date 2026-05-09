/**
 * contextCache.ts — In-process TTL cache
 * Prevents DB + LLM re-fetches on every request.
 */

interface Entry<T> { data: T; expiresAt: number; hits: number }

class ContextCache {
  private store = new Map<string, Entry<unknown>>();

  async get<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const entry = this.store.get(key) as Entry<T> | undefined;
    if (entry && Date.now() < entry.expiresAt) {
      entry.hits++;
      return entry.data;
    }
    const data = await compute();
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs, hits: 0 });
    return data;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  getStore(): Map<string, Entry<unknown>> {
    return this.store;
  }

  stats(): Record<string, { expiresIn: string; hits: number }> {
    const now = Date.now();
    return Object.fromEntries(
      [...this.store.entries()].map(([k, e]) => [k, {
        expiresIn: Math.max(0, Math.ceil((e.expiresAt - now) / 1000)) + "s",
        hits: e.hits,
      }])
    );
  }
}

export const cache = new ContextCache();

export const TTL = {
  PORTFOLIO:        60_000,
  MARKET_PRICES:    5  * 60_000,
  STRATEGY_OPTIONS: 4  * 60 * 60_000,
  MARKET_SCAN:      60 * 60_000,
  INSTRUMENT_IDS:   24 * 60 * 60_000,
  OPERATION_CONFIG: 5  * 60_000,
} as const;

export const CacheKey = {
  portfolio:       ()            => "portfolio:current",
  strategyOptions: ()            => "strategy:options",
  marketScan:      ()            => "scan:latest",
  instrumentId:    (sym: string) => `instrument:${sym.toUpperCase()}`,
  operationConfig: ()            => "config:operation",
  marketPrice:     (sym: string) => `price:${sym.toUpperCase()}`,
} as const;

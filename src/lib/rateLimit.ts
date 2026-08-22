type Entry = { count: number; firstRequestAt: number };

export type RateLimiter = {
  isRateLimited: (key: string) => boolean;
};

const CLEANUP_EVERY_N_CALLS = 50;

export function createRateLimiter(windowMs: number, max: number): RateLimiter {
  const store = new Map<string, Entry>();
  let callsSinceCleanup = 0;

  function cleanup(now: number) {
    // Array.from(...) takes a snapshot of the entries before iterating, so
    // it is safe to call store.delete() inside forEach without triggering a lint
    // warning about for...of (no-restricted-syntax), and without the issues caused
    // by mutating a Map while iterating over it directly.
    Array.from(store.entries()).forEach(([key, entry]) => {
      if (now - entry.firstRequestAt > windowMs) {
        store.delete(key);
      }
    });
  }

  function isRateLimited(key: string): boolean {
    const now = Date.now();

    callsSinceCleanup += 1;
    if (callsSinceCleanup >= CLEANUP_EVERY_N_CALLS) {
      callsSinceCleanup = 0;
      cleanup(now);
    }

    const entry = store.get(key);

    if (!entry) {
      store.set(key, { count: 1, firstRequestAt: now });
      return false;
    }

    if (now - entry.firstRequestAt > windowMs) {
      store.set(key, { count: 1, firstRequestAt: now });
      return false;
    }

    entry.count += 1;
    return entry.count > max;
  }

  return { isRateLimited };
}

/**
 * Best-effort caller IP extraction, shared by every route that rate
 * limits by IP. Same header preference order used by the original
 * feedback/route.ts.
 */
export function getRequestIp(req: Request): string {
  return (
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

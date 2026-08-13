/**
 * Serializes outgoing requests with an adaptive delay (MIAD: Multiplicative
 * Increase, Additive Decrease).
 * 429 -> delay increases (multiplicative). Success -> delay decreases (additive).
 * Global, not per Steam ID, since throttling is IP/session-based.
 */
let minDelayMs = 1000; // floor
let maxDelayMs = 60_000; // ceiling
const INCREASE_FACTOR = 2; // multiplier on 429
const DECREASE_STEP_MS = 250; // step-down once enough consecutive successes happen
const SUCCESSES_BEFORE_DECAY = 3; // require a streak before decaying, so a burst
// of concurrent successful requests right after a 429 doesn't immediately erase
// the backoff we just applied (which would just trigger another 429 shortly after)

let currentDelayMs = minDelayMs;
let lastRequestTime = 0;
let queue: Promise<void> = Promise.resolve();
let consecutiveSuccesses = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Queues the caller behind any in-flight requests and waits until at least
 * currentDelayMs has passed since the last request went out.
 *
 * The body is wrapped in try/catch so the shared `queue` promise can never
 * settle into a rejected state. `.then(onFulfilled)` without a matching
 * `.catch()` propagates a rejection forever: if this block ever threw
 * (it can't today, since sleep() never rejects, but future changes might
 * add logic that can), every subsequent call to applyRateLimit() would
 * reject immediately, silently breaking rate limiting process-wide until
 * restart. The catch here is a safety net against that failure mode.
 */
const applyRateLimit = (): Promise<void> => {
  queue = queue.then(async () => {
    try {
      const elapsed = Date.now() - lastRequestTime;
      const delay = Math.max(0, currentDelayMs - elapsed);
      if (delay > 0) await sleep(delay);
      lastRequestTime = Date.now();
    } catch (err) {
      console.error('[rateLimit] Unexpected error while applying delay:', err);
    }
  });
  return queue;
};

// Back off harder after a 429. Also resets the success streak, so a request
// that was already in flight when the 429 landed can't immediately cancel
// out the backoff we just applied.
export const reportThrottled = (): void => {
  consecutiveSuccesses = 0;
  currentDelayMs = Math.min(
    maxDelayMs,
    Math.round(currentDelayMs * INCREASE_FACTOR),
  );
};

// Ease the delay back down, but only after a streak of consecutive successes.
// Decaying on every single success is too aggressive under concurrency: several
// in-flight requests can succeed right after one 429, which would wipe out the
// backoff before it had a chance to actually relieve pressure on the upstream API.
export const reportSuccess = (): void => {
  consecutiveSuccesses += 1;
  if (consecutiveSuccesses >= SUCCESSES_BEFORE_DECAY) {
    currentDelayMs = Math.max(minDelayMs, currentDelayMs - DECREASE_STEP_MS);
    consecutiveSuccesses = 0;
  }
};

// Current effective delay, mostly for debugging/logging
export const getCurrentDelay = (): number => currentDelayMs;

/**
 * Sets the floor for the adaptive delay AND resets the current delay to it.
 * Intended for test setup / one-time process bootstrap — NOT for calling
 * mid-flight from request-handling code, since it silently wipes out any
 * backoff currently in effect from recent 429s.
 */
export const setMinDelay = (ms: number): void => {
  minDelayMs = ms;
  currentDelayMs = ms;
};

// --- Test-only helpers ---
export const setMaxDelay = (ms: number): void => {
  maxDelayMs = ms;
};
export const getLastRequestTime = (): number => lastRequestTime;
export const resetRateLimiter = (): void => {
  currentDelayMs = minDelayMs;
  lastRequestTime = 0;
  queue = Promise.resolve();
  consecutiveSuccesses = 0;
};

export default applyRateLimit;

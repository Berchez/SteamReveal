/**
 * Serializes outgoing requests to external services with a minimum delay between them.
 *
 * The delay is global (not per Steam ID) because rate limiting often
 * applies to the shared session/cookie or IP address. Throttling
 * per Steam ID would let unlimited concurrent requests through,
 * potentially getting the proxy blocked.
 */

let minDelayMs = 2000; // Minimum delay between consecutive requests (configurable for tests)

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let lastRequestTime = 0;
let queue: Promise<void> = Promise.resolve();

/**
 * Queues the caller behind any in-flight requests and waits until at least
 * minDelayMs has passed since the last request went out.
 */
const applyRateLimit = (): Promise<void> => {
  queue = queue.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    const delay = Math.max(0, minDelayMs - elapsed);
    if (delay > 0) await sleep(delay);
    lastRequestTime = Date.now();
  });
  return queue;
};

// Helpers for tests and fine-tuning in runtime
export const setMinDelay = (ms: number) => {
  minDelayMs = ms;
};
export const getLastRequestTime = () => lastRequestTime;
export const resetRateLimiter = () => {
  lastRequestTime = 0;
  queue = Promise.resolve();
};
export default applyRateLimit;

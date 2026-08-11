/**
 * Serializes outgoing requests to external services with a minimum delay between them.
 *
 * The delay is global (not per Steam ID) because rate limiting often
 * applies to the shared session/cookie or IP address. Throttling
 * per Steam ID would let unlimited concurrent requests through,
 * potentially getting the proxy blocked.
 */

const MIN_DELAY_MS = 2000; // Minimum delay between consecutive requests

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let lastRequestTime = 0;
let queue: Promise<void> = Promise.resolve();

/**
 * Queues the caller behind any in-flight requests and waits until at least
 * MIN_DELAY_MS has passed since the last request went out.
 */
const applyRateLimit = (): Promise<void> => {
  queue = queue.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    const delay = Math.max(0, MIN_DELAY_MS - elapsed);
    if (delay > 0) await sleep(delay);
    lastRequestTime = Date.now();
  });
  return queue;
};

export default applyRateLimit;

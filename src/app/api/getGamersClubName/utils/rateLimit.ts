/**
 * Serializes outgoing requests to GamersClub with a minimum delay between them.
 *
 * The delay is global (not per Steam ID) because GamersClub's rate limiting
 * applies to the shared session/cookie, not to individual players. Throttling
 * per Steam ID would let unlimited concurrent requests for different players
 * through, defeating the purpose.
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

import {
  PENDING_POLL_FAST_MS,
  PENDING_POLL_FAST_ROUNDS,
  PENDING_POLL_SLOW_MS,
  PENDING_RATE_LIMIT_MAX,
  PENDING_RATE_LIMIT_WINDOW_MS,
  pendingPollDelay,
} from './pendingPolicy';

describe('pendingPollDelay', () => {
  it('polls fast for the first minute, then relaxes', () => {
    for (let n = 0; n < PENDING_POLL_FAST_ROUNDS; n += 1) {
      expect(pendingPollDelay(n)).toBe(PENDING_POLL_FAST_MS);
    }
    expect(pendingPollDelay(PENDING_POLL_FAST_ROUNDS)).toBe(
      PENDING_POLL_SLOW_MS,
    );
    expect(pendingPollDelay(10_000)).toBe(PENDING_POLL_SLOW_MS);
  });

  it('pins the client/server contract: worst cadence fits the rate budget', () => {
    // Even the fast tier (10s ⇒ 6/min, ×2 tabs worst case) stays far under
    // the per-IP budget — and the slow tier (2/min) further still. If
    // anyone retunes either side past this inequality, this test (not a
    // silent 429 in production) is what fails.
    const fastPerMinute =
      (60_000 / PENDING_POLL_FAST_MS) * 2; // ×2 tabs, worst case
    expect(fastPerMinute).toBeLessThan(PENDING_RATE_LIMIT_MAX);
    expect(60_000 / PENDING_POLL_SLOW_MS).toBeLessThan(
      PENDING_RATE_LIMIT_MAX,
    );
    expect(PENDING_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
});

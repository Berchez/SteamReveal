import applyRateLimit, {
  setMinDelay,
  setMaxDelay,
  getLastRequestTime,
  getCurrentDelay,
  resetRateLimiter,
  reportThrottled,
  reportSuccess,
} from './rateLimit';

jest.setTimeout(10000);

describe('applyRateLimit', () => {
  beforeEach(() => {
    resetRateLimiter();
    setMinDelay(50);
    setMaxDelay(10000);
  });

  it('serializes calls and enforces minimum delay between requests', async () => {
    // First call primes the limiter
    await applyRateLimit();
    const t1 = getLastRequestTime();

    // Call again; should ensure at least minDelay elapsed between t1 and new lastRequestTime
    await applyRateLimit();
    const t2 = getLastRequestTime();

    expect(t2 - t1).toBeGreaterThanOrEqual(45);
  });
});

describe('adaptive delay (reportThrottled / reportSuccess)', () => {
  beforeEach(() => {
    resetRateLimiter();
    setMinDelay(50);
    setMaxDelay(300);
  });

  it('starts at the configured floor', () => {
    expect(getCurrentDelay()).toBe(50);
  });

  it('doubles the delay on each reportThrottled call, clamped to the max', () => {
    reportThrottled();
    expect(getCurrentDelay()).toBe(100);

    reportThrottled();
    expect(getCurrentDelay()).toBe(200);

    // 200 * 2 = 400, but max is 300 -> clamp
    reportThrottled();
    expect(getCurrentDelay()).toBe(300);

    // Already at the ceiling -> stays there
    reportThrottled();
    expect(getCurrentDelay()).toBe(300);
  });

  it('does not decrease the delay until a streak of consecutive successes is reached', () => {
    reportThrottled(); // delay = 100
    const throttled = getCurrentDelay();

    reportSuccess();
    expect(getCurrentDelay()).toBe(throttled);

    reportSuccess();
    expect(getCurrentDelay()).toBe(throttled);

    // 3rd consecutive success -> streak requirement met, delay decays
    reportSuccess();
    expect(getCurrentDelay()).toBeLessThan(throttled);
  });

  it('never decreases the delay below the configured floor', () => {
    reportThrottled(); // delay = 100

    for (let i = 0; i < 50; i += 1) {
      reportSuccess();
    }

    expect(getCurrentDelay()).toBe(50);
  });

  it('resets the consecutive-success streak whenever a throttle happens', () => {
    reportThrottled(); // delay = 100
    reportSuccess();
    reportSuccess(); // 2 in a row; one more would normally trigger decay

    reportThrottled(); // streak resets here, delay doubles again -> 200
    const delayAfterSecondThrottle = getCurrentDelay();
    expect(delayAfterSecondThrottle).toBe(200);

    reportSuccess();
    reportSuccess(); // only 2 successes since the reset -> still no decay
    expect(getCurrentDelay()).toBe(delayAfterSecondThrottle);

    reportSuccess(); // 3rd since the reset -> now it decays
    expect(getCurrentDelay()).toBeLessThan(delayAfterSecondThrottle);
  });
});

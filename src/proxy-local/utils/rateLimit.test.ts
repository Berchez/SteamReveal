import applyRateLimit, { setMinDelay, getLastRequestTime, resetRateLimiter } from './rateLimit';

jest.setTimeout(10000);

describe('applyRateLimit', () => {
  beforeEach(() => {
    resetRateLimiter();
    setMinDelay(50);
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

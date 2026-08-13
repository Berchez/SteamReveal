import withRetry from './withRetry';
import applyRateLimit, { reportSuccess, reportThrottled } from './rateLimit';

// rateLimit.ts is mocked here so these tests exercise withRetry's own
// decision logic (when to retry, when to back off locally) in isolation,
// without depending on real timers for the global delay. The real,
// end-to-end behavior of rateLimit.ts itself is covered in rateLimit.test.ts,
// and the two working together in practice is covered in
// scrapeGamersClubName.test.ts.
jest.mock('./rateLimit', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
  reportSuccess: jest.fn(),
  reportThrottled: jest.fn(),
}));

const mockedApplyRateLimit = applyRateLimit as jest.MockedFunction<
  typeof applyRateLimit
>;
const mockedReportSuccess = reportSuccess as jest.MockedFunction<
  typeof reportSuccess
>;
const mockedReportThrottled = reportThrottled as jest.MockedFunction<
  typeof reportThrottled
>;

jest.setTimeout(10000);

describe('withRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApplyRateLimit.mockResolvedValue(undefined);
  });

  it('retries until success and returns the value', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });

    const res = await withRetry(fn, {
      attempts: 5,
      baseDelayMs: 10,
      factor: 1.2,
    });

    expect(res).toBe('ok');
    expect(calls).toBe(3);
    expect(mockedReportSuccess).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when shouldRetry returns false', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      const err: any = new Error('fatal');
      err.status = 400;
      throw err;
    });

    await expect(
      withRetry(fn, {
        attempts: 3,
        baseDelayMs: 1,
        shouldRetry: (err) => (err as any)?.status !== 400,
      }),
    ).rejects.toThrow('fatal');

    expect(calls).toBe(1);
    expect(mockedReportThrottled).not.toHaveBeenCalled();
  });

  it('reports throttling and skips the local backoff delay on 429', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      const err: any = new Error('rate limited');
      err.status = 429;
      if (calls < 3) throw err;
      return 'ok';
    });

    const start = Date.now();
    const res = await withRetry(fn, {
      attempts: 5,
      baseDelayMs: 5000,
      factor: 3,
    });
    const elapsed = Date.now() - start;

    expect(res).toBe('ok');
    expect(calls).toBe(3);
    // With a 5000ms base and factor 3, a local backoff would take seconds.
    // Since it's skipped for 429s, the whole loop should resolve almost
    // instantly (bounded well under a single backoff step).
    expect(elapsed).toBeLessThan(500);
    expect(mockedReportThrottled).toHaveBeenCalledTimes(2);
    expect(mockedReportSuccess).toHaveBeenCalledTimes(1);
  });

  it('still calls reportThrottled on a 429 even on the final attempt (no retry left)', async () => {
    const fn = jest.fn(async () => {
      const err: any = new Error('rate limited');
      err.status = 429;
      throw err;
    });

    await expect(
      withRetry(fn, { attempts: 1, baseDelayMs: 5000 }),
    ).rejects.toThrow('rate limited');

    expect(mockedReportThrottled).toHaveBeenCalledTimes(1);
  });

  it('applies local exponential backoff for non-429 errors', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 2) throw new Error('network error');
      return 'ok';
    });

    const start = Date.now();
    await withRetry(fn, { attempts: 3, baseDelayMs: 100, factor: 2 });
    const elapsed = Date.now() - start;

    // One retry with baseDelayMs=100 -> jitter between 50ms and 100ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(mockedReportThrottled).not.toHaveBeenCalled();
  });
});

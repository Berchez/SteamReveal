/**
 * @jest-environment node
 */
const {
  SMOKE_TIMEOUT_CODE,
  createTimeoutError,
  isTimeoutError,
  withTimeout,
  fetchWithTimeout,
} = require('./smoke-timeout.cjs');

describe('createTimeoutError', () => {
  it('carries the SMOKE_TIMEOUT code and the label', () => {
    const err = createTimeoutError('turso SELECT 1');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(SMOKE_TIMEOUT_CODE);
    expect(err.message).toContain('turso SELECT 1');
  });
});

describe('isTimeoutError', () => {
  it('matches helper timeouts by code', () => {
    expect(isTimeoutError(createTimeoutError('x'))).toBe(true);
  });

  it('matches AbortSignal.timeout() fetch rejections by name', () => {
    const domTimeout = new DOMException('The operation timed out', 'TimeoutError');
    expect(isTimeoutError(domTimeout)).toBe(true);
  });

  it('rejects ordinary errors, aborts and empty values', () => {
    expect(isTimeoutError(new Error('fetch failed'))).toBe(false);
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(isTimeoutError(abort)).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError('SMOKE TIMEOUT: x')).toBe(false);
  });
});

describe('withTimeout', () => {
  it('resolves with the inner value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'fast')).resolves.toBe(42);
  });

  it('rejects with a timeout error when the budget expires', async () => {
    const never = new Promise(() => {});
    const err = await withTimeout(never, 10, 'slow-op').catch((e: unknown) => e);
    expect(isTimeoutError(err)).toBe(true);
    expect(String((err as Error).message)).toContain('slow-op');
  });

  it('propagates the inner rejection untouched when it loses no race', async () => {
    const boom = new Error('genuine failure');
    await expect(withTimeout(Promise.reject(boom), 1000, 'failing')).rejects.toBe(boom);
  });

  it('throws on a non-positive budget instead of hanging', () => {
    expect(() => withTimeout(Promise.resolve(1), 0, 'zero')).toThrow();
    expect(() => withTimeout(Promise.resolve(1), -5, 'neg')).toThrow();
  });
});

describe('fetchWithTimeout', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('forwards url/options and adds a timeout signal', async () => {
    const seen: { url?: unknown; options?: RequestInit } = {};
    global.fetch = jest.fn(async (url: string, options?: RequestInit) => {
      seen.url = url;
      seen.options = options;
      return { ok: true };
    }) as unknown as typeof fetch;
    const res = await fetchWithTimeout(
      'http://localhost:3000/api/x',
      { method: 'POST' },
      5000,
    );
    expect(res.ok).toBe(true);
    expect(seen.url).toBe('http://localhost:3000/api/x');
    expect(seen.options?.method).toBe('POST');
    expect(seen.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces an expired budget as a timeout error', async () => {
    global.fetch = jest.fn(async (_url: string, options: { signal: AbortSignal }) => {
      const { signal } = options;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        });
      });
    }) as unknown as typeof fetch;
    const err = await fetchWithTimeout('http://localhost:3000/api/x', {}, 10).catch(
      (e: unknown) => e,
    );
    expect(isTimeoutError(err)).toBe(true);
  });
});

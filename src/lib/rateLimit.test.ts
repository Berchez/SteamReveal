/**
 * @jest-environment node
 *
 * Needed because this suite exercises getRequestIp against a real
 * `Request` instance — the Fetch API's `Request`/`Headers` globals aren't
 * available under this project's default (jsdom-based) Jest environment.
 */

import { createRateLimiter, getRequestIp } from './rateLimit';

describe('createRateLimiter', () => {
  it('does not rate limit the first request for a key', () => {
    const limiter = createRateLimiter(1000, 2);
    expect(limiter.isRateLimited('ip-1')).toBe(false);
  });

  it('allows requests up to the max, then blocks', () => {
    const limiter = createRateLimiter(1000, 2);
    expect(limiter.isRateLimited('ip-1')).toBe(false); // 1st
    expect(limiter.isRateLimited('ip-1')).toBe(false); // 2nd
    expect(limiter.isRateLimited('ip-1')).toBe(true); // 3rd — over max
  });

  it('tracks separate keys independently', () => {
    const limiter = createRateLimiter(1000, 1);
    expect(limiter.isRateLimited('ip-1')).toBe(false);
    expect(limiter.isRateLimited('ip-2')).toBe(false);
    // ip-1 is now at its limit, ip-2 should be unaffected
    expect(limiter.isRateLimited('ip-1')).toBe(true);
    expect(limiter.isRateLimited('ip-2')).toBe(true);
  });

  it('resets the count once the window has elapsed', () => {
    jest.useFakeTimers();
    try {
      const limiter = createRateLimiter(1000, 1);
      expect(limiter.isRateLimited('ip-1')).toBe(false);
      expect(limiter.isRateLimited('ip-1')).toBe(true);

      jest.advanceTimersByTime(1001);

      // Window has passed — this should be treated as a fresh window.
      expect(limiter.isRateLimited('ip-1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('getRequestIp', () => {
  it('prefers x-real-ip when present', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' },
    });
    expect(getRequestIp(req)).toBe('1.1.1.1');
  });

  it('falls back to the first entry of x-forwarded-for', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '3.3.3.3, 4.4.4.4' },
    });
    expect(getRequestIp(req)).toBe('3.3.3.3');
  });

  it('falls back to "unknown" when no IP header is present', () => {
    const req = new Request('http://localhost');
    expect(getRequestIp(req)).toBe('unknown');
  });
});

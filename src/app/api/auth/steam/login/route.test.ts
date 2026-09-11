/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

describe('GET /api/auth/steam/login', () => {
  const base = 'http://localhost:3000';

  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
  });

  it('redirects to Steam with a complete OpenID request', async () => {
    const res = await GET(
      new Request(`${base}/api/auth/steam/login?next=/pt/watch`),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toContain('https://steamcommunity.com/openid/login');
    const url = new URL(location as string);
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    // Context preserved inside return_to for the callback leg.
    expect(url.searchParams.get('openid.return_to')).toContain(
      '/api/auth/steam/callback?next=%2Fpt%2Fwatch',
    );
    expect(url.searchParams.get('openid.realm')).toBe(base);
  });

  it('falls back to /watch for missing or hostile next params (no open redirect)', async () => {
    for (const next of [
      null,
      '',
      'https://evil.example/x',
      '//evil.example/x',
    ]) {
      const suffix = next === null ? '' : `?next=${encodeURIComponent(next)}`;
      const res = await GET(
        new Request(`${base}/api/auth/steam/login${suffix}`),
      );
      const returnTo = new URL(
        new URL(res.headers.get('location') as string).searchParams.get(
          'openid.return_to',
        ) as string,
      );
      expect(returnTo.searchParams.get('next')).toBe('/watch');
    }
  });

  it('plants a single-use state nonce (cookie + return_to echo)', async () => {
    const res = await GET(
      new Request(`${base}/api/auth/steam/login?next=/pt/watch`),
    );

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('steamreveal_oauth_state=');
    expect(setCookie).toContain('HttpOnly');
    const state = (
      setCookie.match(/steamreveal_oauth_state=([^;]+)/) as RegExpMatchArray
    )[1];
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    const returnTo = new URL(
      new URL(res.headers.get('location') as string).searchParams.get(
        'openid.return_to',
      ) as string,
    );
    expect(returnTo.searchParams.get('state')).toBe(state);
  });

  it('rejects non-GET methods', async () => {
    const res = await GET(
      new Request(`${base}/api/auth/steam/login`, { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 429 when rate limited', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await GET(new Request(`${base}/api/auth/steam/login`));

    expect(res.status).toBe(429);
  });
});

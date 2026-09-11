/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  saveWatchSession: jest.fn(),
}));

jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

jest.mock('@/lib/watch/steamOpenId', () => ({
  isSafeNextPath: jest.requireActual('@/lib/watch/steamOpenId').isSafeNextPath,
  verifySteamAssertion: jest.fn(),
}));

const { cookies } = jest.requireMock('next/headers') as {
  cookies: jest.Mock;
};
const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};
const { saveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  saveWatchSession: jest.Mock;
};
const { verifySteamAssertion } = jest.requireMock(
  '@/lib/watch/steamOpenId',
) as {
  verifySteamAssertion: jest.Mock;
};

const STEAM = '76561198000000001';
const BASE = 'http://localhost:3000';
const CALLBACK = `${BASE}/api/auth/steam/callback`;
const STATE = 'state-nonce-123';

const callbackUrl = (extra = '') =>
  `${CALLBACK}?openid.mode=id_res&openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F${STEAM}&openid.sig=abc&next=/pt/watch${extra}`;

describe('GET /api/auth/steam/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    // Matching login-CSRF nonce by default; mismatch cases override it.
    cookies.mockReturnValue({
      get: (name: string) =>
        name === 'steamreveal_oauth_state' ? { value: STATE } : undefined,
    });
    verifySteamAssertion.mockResolvedValue(STEAM);
    saveWatchSession.mockResolvedValue(undefined);
  });

  it('verifies state, saves the session, and returns to next on success', async () => {
    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch`);
    // The auth-only params ride along to verifySteamAssertion, whose
    // openid.* filter is the actual boundary (unit-pinned in
    // steamOpenId.test.ts) — never to Steam itself.
    const sent = verifySteamAssertion.mock.calls[0][0] as Record<
      string,
      string
    >;
    expect(sent['openid.mode']).toBe('id_res');
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
    // Single-use nonce: consumed on success…
    expect(res.headers.get('set-cookie')).toContain(
      'steamreveal_oauth_state=;',
    );
  });

  it('rejects mismatched, missing, or absent state before touching Steam', async () => {
    for (const url of [
      `${callbackUrl()}&state=wrong-nonce`,
      `${callbackUrl()}`,
    ]) {
      const res = await GET(new Request(url));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    }

    cookies.mockReturnValue({ get: () => undefined });
    const noCookie = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(noCookie.headers.get('location')).toBe(
      `${BASE}/pt/watch?auth=error`,
    );

    expect(verifySteamAssertion).not.toHaveBeenCalled();
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('redirects to next?auth=error when Steam rejects the assertion', async () => {
    verifySteamAssertion.mockResolvedValue(null);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('redirects to next?auth=error when verification or save blows up', async () => {
    verifySteamAssertion.mockRejectedValueOnce(new Error('socket hang up'));
    const first = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(first.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);

    verifySteamAssertion.mockResolvedValueOnce(STEAM);
    saveWatchSession.mockRejectedValueOnce(new Error('db down'));
    const second = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(second.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
  });

  it('falls back to /watch for hostile next params (no open redirect)', async () => {
    const res = await GET(
      new Request(
        `${CALLBACK}?openid.mode=id_res&next=https://evil.example/&state=${STATE}`,
      ),
    );

    // Success path still lands on the safe fallback — never the evil URL.
    expect(res.headers.get('location')).toBe(`${BASE}/watch`);

    verifySteamAssertion.mockResolvedValueOnce(null);
    const failed = await GET(
      new Request(
        `${CALLBACK}?openid.mode=id_res&next=//evil.example/&state=${STATE}`,
      ),
    );
    expect(failed.headers.get('location')).toBe(`${BASE}/watch?auth=error`);
  });

  it('rejects non-GET methods', async () => {
    const res = await GET(new Request(CALLBACK, { method: 'POST' }));
    expect(res.status).toBe(405);
  });

  it('returns 429 when rate limited (before any Steam I/O)', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(429);
    expect(verifySteamAssertion).not.toHaveBeenCalled();
  });
});

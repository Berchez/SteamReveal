/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/completeLogin', () => ({
  completeProvenLogin: jest.fn(),
}));

jest.mock('@/lib/watch/pendingLogin', () => ({
  savePendingLogin: jest.fn(),
}));

jest.mock('@/lib/getSteamApiKey', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@/lib/steamFriendList', () => ({
  isBotFriend: jest.fn(),
}));

// Passthrough by default: with real timers, an 8s timeout would slow the
// suite — the timeout test overrides this with a rejection.
jest.mock('@/lib/withTimeout', () => ({
  __esModule: true,
  default: jest.fn((promise: Promise<unknown>) => promise),
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
const { savePendingLogin } = jest.requireMock('@/lib/watch/pendingLogin') as {
  savePendingLogin: jest.Mock;
};
const { completeProvenLogin } = jest.requireMock(
  '@/lib/watch/completeLogin',
) as {
  completeProvenLogin: jest.Mock;
};
const getSteamApiKey = jest.requireMock('@/lib/getSteamApiKey').default as jest.Mock;
const { isBotFriend } = jest.requireMock('@/lib/steamFriendList') as {
  isBotFriend: jest.Mock;
};
const withTimeoutMock = jest.requireMock('@/lib/withTimeout').default as jest.Mock;
const { verifySteamAssertion } = jest.requireMock(
  '@/lib/watch/steamOpenId',
) as {
  verifySteamAssertion: jest.Mock;
};

const STEAM = '76561198000000001';
const BOT = '76561199000000001';
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
    savePendingLogin.mockResolvedValue(undefined);
    // Single-state gate defaults: configured env + an existing friend.
    getSteamApiKey.mockReturnValue('test-api-key');
    process.env.STEAM_BOT_STEAMID = BOT;
    isBotFriend.mockResolvedValue(true);
    // Shared completion defaults to the idempotent re-login (no welcome).
    completeProvenLogin.mockResolvedValue({ activated: false, locale: 'pt' });
  });

  afterEach(() => {
    delete process.env.STEAM_BOT_STEAMID;
    jest.restoreAllMocks();
  });

  it('verifies state, gates on friendship, and completes via the shared helper', async () => {
    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    // Repeat login (activated=false): no one-shot param on the landing.
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch`);
    expect(isBotFriend).toHaveBeenCalledTimes(1);
    expect(isBotFriend).toHaveBeenCalledWith('test-api-key', BOT, STEAM);
    // One call carries steamId + destination + log scope (the helper owns
    // ensure/record/welcome/seal — asserted in completeLogin.test.ts).
    expect(completeProvenLogin).toHaveBeenCalledTimes(1);
    expect(completeProvenLogin).toHaveBeenCalledWith(
      expect.anything(),
      STEAM,
      '/pt/watch',
      'steamCallback',
    );
    // Single-use nonce: consumed on success…
    expect(res.headers.get('set-cookie')).toContain(
      'steamreveal_oauth_state=;',
    );
  });

  it('first login (activated=true): lands with the one-shot watch param', async () => {
    completeProvenLogin.mockResolvedValueOnce({
      activated: true,
      locale: 'pt',
    });

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?watch=new`);
  });

  it('confirm-lane re-login (activated=false): lands clean, no watch param', async () => {
    // Pending-preservation lives in the shared helper (pinned there and
    // in the DAL) — the route just honors activated=false.
    completeProvenLogin.mockResolvedValueOnce({ activated: false, locale: 'pt' });

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch`);
    expect(completeProvenLogin).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched, missing, or absent state before touching Steam or the gate', async () => {
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
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(completeProvenLogin).not.toHaveBeenCalled();
  });

  it('redirects to next?auth=error when Steam rejects the assertion (gate untouched)', async () => {
    verifySteamAssertion.mockResolvedValue(null);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(completeProvenLogin).not.toHaveBeenCalled();
  });

  it('holds (never denies) a non-friend in the waiting room: pending sealed, no session, no writes', async () => {
    isBotFriend.mockResolvedValueOnce(false);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${BASE}/pt/watch?login=waiting`,
    );
    // The verified identity is held for the waiting room — nothing else.
    expect(savePendingLogin).toHaveBeenCalledTimes(1);
    expect(savePendingLogin).toHaveBeenCalledWith(
      expect.anything(),
      STEAM,
      '/pt/watch',
    );
    expect(completeProvenLogin).not.toHaveBeenCalled();
    // Single-use nonce is consumed on the hold too.
    expect(res.headers.get('set-cookie')).toContain(
      'steamreveal_oauth_state=;',
    );
  });

  it('denies fail-closed when friendship is UNKNOWN (Steam API down/private list)', async () => {
    isBotFriend.mockResolvedValueOnce(null);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(completeProvenLogin).not.toHaveBeenCalled();

    // Same fail-closed posture when the bounded check itself times out.
    withTimeoutMock.mockRejectedValueOnce(
      new Error('steamCallback: GetFriendList timed out'),
    );
    const timedOut = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(timedOut.headers.get('location')).toBe(
      `${BASE}/pt/watch?auth=error`,
    );
    expect(completeProvenLogin).not.toHaveBeenCalled();
  });

  it('denies fail-closed when the gate is misconfigured (missing key or bad bot id)', async () => {
    getSteamApiKey.mockReturnValueOnce(undefined);

    const noKey = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(noKey.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(completeProvenLogin).not.toHaveBeenCalled();

    process.env.STEAM_BOT_STEAMID = 'not-a-steamid';
    const badBotId = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(badBotId.headers.get('location')).toBe(
      `${BASE}/pt/watch?auth=error`,
    );
    expect(isBotFriend).not.toHaveBeenCalled();
  });

  it('denies login (no session) when the shared completion fails — the invariant is enforced here', async () => {
    completeProvenLogin.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
  });

  it('redirects to next?auth=error when verification or completion blows up', async () => {
    verifySteamAssertion.mockRejectedValueOnce(new Error('socket hang up'));
    const first = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(first.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);

    verifySteamAssertion.mockResolvedValueOnce(STEAM);
    completeProvenLogin.mockRejectedValueOnce(new Error('db down'));
    const second = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(second.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
  });

  it('falls back to / for hostile next params (no open redirect)', async () => {
    const res = await GET(
      new Request(
        `${CALLBACK}?openid.mode=id_res&next=https://evil.example/&state=${STATE}`,
      ),
    );

    // Success path still lands on the safe fallback — never the evil URL.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/`);
    // The raw destination rides into the shared completion (locale
    // resolution for a bare `/` happens there — asserted in
    // completeLogin.test.ts).
    expect(completeProvenLogin).toHaveBeenCalledWith(
      expect.anything(),
      STEAM,
      '/',
      'steamCallback',
    );

    verifySteamAssertion.mockResolvedValueOnce(null);
    const failed = await GET(
      new Request(
        `${CALLBACK}?openid.mode=id_res&next=//evil.example/&state=${STATE}`,
      ),
    );
    expect(failed.headers.get('location')).toBe(`${BASE}/?auth=error`);
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
    expect(isBotFriend).not.toHaveBeenCalled();
  });
});

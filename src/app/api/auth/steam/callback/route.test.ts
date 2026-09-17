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

jest.mock('@/lib/analytics/db', () => ({
  ensureActiveWatch: jest.fn(),
  recordLogin: jest.fn(),
  enqueueEvent: jest.fn(),
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
const getSteamApiKey = jest.requireMock('@/lib/getSteamApiKey').default as jest.Mock;
const { isBotFriend } = jest.requireMock('@/lib/steamFriendList') as {
  isBotFriend: jest.Mock;
};
const withTimeoutMock = jest.requireMock('@/lib/withTimeout').default as jest.Mock;
const { ensureActiveWatch, recordLogin, enqueueEvent } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  ensureActiveWatch: jest.Mock;
  recordLogin: jest.Mock;
  enqueueEvent: jest.Mock;
};
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

const ACTIVE_PROFILE = {
  steamId: STEAM,
  status: 'active',
  locale: 'pt',
  requestedAt: '2026-09-16T00:00:00.000Z',
  activatedAt: '2026-09-16T00:00:00.000Z',
  lastNotifiedAt: null,
};

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
    // Single-state gate defaults: configured env + an existing friend.
    getSteamApiKey.mockReturnValue('test-api-key');
    process.env.STEAM_BOT_STEAMID = BOT;
    isBotFriend.mockResolvedValue(true);
    ensureActiveWatch.mockResolvedValue({
      profile: ACTIVE_PROFILE,
      activated: false,
    });
    recordLogin.mockResolvedValue({ ...ACTIVE_PROFILE, createdAt: ACTIVE_PROFILE.requestedAt });
    enqueueEvent.mockResolvedValue({ eventId: 1, duplicate: false });
  });

  afterEach(() => {
    delete process.env.STEAM_BOT_STEAMID;
    jest.restoreAllMocks();
  });

  it('verifies state, gates on friendship, ensures the watch, records the login, seals the session', async () => {
    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    // Repeat login (activated=false): no one-shot param on the landing.
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch`);
    expect(isBotFriend).toHaveBeenCalledTimes(1);
    expect(isBotFriend).toHaveBeenCalledWith('test-api-key', BOT, STEAM);
    // Locale for the watch/login rows comes from the page the user was
    // on (next carries the locale prefix).
    expect(ensureActiveWatch).toHaveBeenCalledWith(STEAM, 'pt');
    expect(recordLogin).toHaveBeenCalledWith(STEAM, 'pt');
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
    // Single-use nonce: consumed on success…
    expect(res.headers.get('set-cookie')).toContain(
      'steamreveal_oauth_state=;',
    );
  });

  it('first login (activated=true): enqueues ONE welcome and lands with the one-shot watch param', async () => {
    ensureActiveWatch.mockResolvedValueOnce({
      profile: ACTIVE_PROFILE,
      activated: true,
    });

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?watch=new`);
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent).toHaveBeenCalledWith(STEAM, 'welcome');
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('confirm-lane re-login (pending preserved, activated=false): session seals, no welcome, no watch param', async () => {
    // ensureActiveWatch leaves pending rows with an unconfirmed account
    // alone (the outstanding link click owns them) — the login still
    // succeeds, it just does not activate or welcome.
    ensureActiveWatch.mockResolvedValueOnce({
      profile: { ...ACTIVE_PROFILE, status: 'pending', activatedAt: null },
      activated: false,
    });

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch`);
    expect(recordLogin).toHaveBeenCalledTimes(1);
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
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
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('redirects to next?auth=error when Steam rejects the assertion (gate untouched)', async () => {
    verifySteamAssertion.mockResolvedValue(null);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('denies a non-friend with the distinct auth=nofriend landing (no session, no writes)', async () => {
    isBotFriend.mockResolvedValueOnce(false);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${BASE}/pt/watch?auth=nofriend`,
    );
    expect(saveWatchSession).not.toHaveBeenCalled();
    expect(ensureActiveWatch).not.toHaveBeenCalled();
    expect(recordLogin).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
    // Single-use nonce is consumed on the denial too.
    expect(res.headers.get('set-cookie')).toContain(
      'steamreveal_oauth_state=;',
    );
  });

  it('denies fail-closed when friendship is UNKNOWN (Steam API down/private list)', async () => {
    isBotFriend.mockResolvedValueOnce(null);

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(saveWatchSession).not.toHaveBeenCalled();
    expect(ensureActiveWatch).not.toHaveBeenCalled();

    // Same fail-closed posture when the bounded check itself times out.
    withTimeoutMock.mockRejectedValueOnce(
      new Error('steamCallback: GetFriendList timed out'),
    );
    const timedOut = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(timedOut.headers.get('location')).toBe(
      `${BASE}/pt/watch?auth=error`,
    );
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('denies fail-closed when the gate is misconfigured (missing key or bad bot id)', async () => {
    getSteamApiKey.mockReturnValueOnce(undefined);

    const noKey = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(noKey.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(saveWatchSession).not.toHaveBeenCalled();

    process.env.STEAM_BOT_STEAMID = 'not-a-steamid';
    const badBotId = await GET(new Request(`${callbackUrl()}&state=${STATE}`));
    expect(badBotId.headers.get('location')).toBe(
      `${BASE}/pt/watch?auth=error`,
    );
    expect(isBotFriend).not.toHaveBeenCalled();
  });

  it('denies login (no session) when ensureActiveWatch fails — the invariant is enforced here', async () => {
    ensureActiveWatch.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?auth=error`);
    expect(saveWatchSession).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('a failed recordLogin never costs the login (audit is non-fatal)', async () => {
    recordLogin.mockRejectedValueOnce(new Error('audit down'));

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch`);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('a failed welcome enqueue is retried 3x and never costs the login', async () => {
    ensureActiveWatch.mockResolvedValueOnce({
      profile: ACTIVE_PROFILE,
      activated: true,
    });
    enqueueEvent.mockRejectedValue(new Error('outbox down'));

    const res = await GET(new Request(`${callbackUrl()}&state=${STATE}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/pt/watch?watch=new`);
    expect(enqueueEvent).toHaveBeenCalledTimes(3);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
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

  it('falls back to / for hostile next params (no open redirect)', async () => {
    const res = await GET(
      new Request(
        `${CALLBACK}?openid.mode=id_res&next=https://evil.example/&state=${STATE}`,
      ),
    );

    // Success path still lands on the safe fallback — never the evil URL.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/`);
    // Bare next carries no locale: the watch/login rows record null.
    expect(ensureActiveWatch).toHaveBeenCalledWith(STEAM, null);

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

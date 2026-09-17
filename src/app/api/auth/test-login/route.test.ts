/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  saveWatchSession: jest.fn(),
}));

jest.mock('@/lib/analytics/db', () => ({
  ensureActiveWatch: jest.fn(),
}));

jest.mock('@/mocks/devFixtures', () => ({
  isMockModeEnabled: jest.fn(),
}));

const { saveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  saveWatchSession: jest.Mock;
};
const { ensureActiveWatch } = jest.requireMock('@/lib/analytics/db') as {
  ensureActiveWatch: jest.Mock;
};
const { isMockModeEnabled } = jest.requireMock('@/mocks/devFixtures') as {
  isMockModeEnabled: jest.Mock;
};

const STEAM = '76561198000000001';
const URL = 'http://localhost:3000/api/auth/test-login';
const SECRET = 'unit-test-e2e-secret';

const postLogin = (body: unknown, secret: string | null = SECRET) =>
  POST(
    new Request(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret === null ? {} : { 'x-e2e-test-secret': secret }),
      },
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/auth/test-login', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    isMockModeEnabled.mockReturnValue(true);
    saveWatchSession.mockResolvedValue(undefined);
    ensureActiveWatch.mockResolvedValue({ profile: null, activated: true });
    process.env.E2E_TEST_SECRET = SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('seals a session for a valid id when both gates pass', async () => {
    const res = await postLogin({ steamId: STEAM });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, steamId: STEAM });
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
    // Single-state seam: the e2e session lands on an ACTIVE watch row
    // (locale-less — e2e drives locale through its own mocks).
    expect(ensureActiveWatch).toHaveBeenCalledWith(STEAM, null);
  });

  it('still seals when the watch ensure fails (e2e runs without DATABASE_URL)', async () => {
    // Best-effort by contract: a DB-less e2e web server must not break
    // the seam — the failure logs loudly and the session still seals.
    ensureActiveWatch.mockRejectedValueOnce(
      new Error('DATABASE_URL is missing'),
    );

    const res = await postLogin({ steamId: STEAM });

    expect(res.status).toBe(200);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('404s when mock mode is off (never reachable in production)', async () => {
    isMockModeEnabled.mockReturnValue(false);

    const res = await postLogin({ steamId: STEAM });

    expect(res.status).toBe(404);
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('404s without the test secret even when mock mode is on (second layer)', async () => {
    for (const secret of [null, 'wrong-secret', '']) {
      const res = await postLogin({ steamId: STEAM }, secret);

      expect(res.status).toBe(404);
    }
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('404s when the server has no expected secret configured', async () => {
    delete process.env.E2E_TEST_SECRET;

    const res = await postLogin({ steamId: STEAM });

    // Fail-closed: no expected value anywhere means no header can match.
    expect(res.status).toBe(404);
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('rejects invalid ids and non-POST methods', async () => {
    const bad = await postLogin({ steamId: 'nope' });
    expect(bad.status).toBe(400);

    const wrongMethod = await POST(new Request(URL, { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
  });
});

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

jest.mock('@/mocks/devFixtures', () => ({
  isMockModeEnabled: jest.fn(),
}));

const { saveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  saveWatchSession: jest.Mock;
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

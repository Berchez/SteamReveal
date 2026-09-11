/**
 * @jest-environment node
 */

import {
  createSessionData,
  destroyWatchSession,
  getSessionPassword,
  getSessionSteamId,
  isSessionDataValid,
  resolveWatchSession,
  saveWatchSession,
  WATCH_SESSION_TTL_MS,
} from './session';

jest.mock('iron-session', () => ({
  getIronSession: jest.fn(),
}));

import { getIronSession } from 'iron-session';

const mockGetIronSession = getIronSession as jest.Mock;

const STEAM = '76561198000000001';

const makeStore = () => ({
  get: jest.fn(),
  set: jest.fn(),
});

describe('getSessionPassword', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns secrets of 32+ chars', () => {
    process.env.SESSION_SECRET = 'x'.repeat(32);
    expect(getSessionPassword()).toBe('x'.repeat(32));
  });

  it('throws loudly on missing or short secrets (fail closed, never sessionless)', () => {
    delete process.env.SESSION_SECRET;
    expect(() => getSessionPassword()).toThrow(/SESSION_SECRET/);

    process.env.SESSION_SECRET = 'too-short';
    expect(() => getSessionPassword()).toThrow(/32\+ chars/);
  });
});

describe('createSessionData / isSessionDataValid', () => {
  it('creates a 30-day payload for valid ids', () => {
    const before = Date.now();
    const data = createSessionData(STEAM);

    expect(data.steamId).toBe(STEAM);
    expect(data.expiresAt).toBeGreaterThan(
      before + WATCH_SESSION_TTL_MS - 1000,
    );
    expect(data.expiresAt).toBeLessThanOrEqual(
      Date.now() + WATCH_SESSION_TTL_MS,
    );
    expect(isSessionDataValid(data)).toBe(true);
  });

  it('rejects malformed ids at creation', () => {
    expect(() => createSessionData('short')).toThrow(/17 digits/);
  });

  it.each([null, undefined, 'x', 42, {}, { steamId: STEAM }])(
    'rejects %p without throwing',
    (data) => {
      expect(isSessionDataValid(data)).toBe(false);
    },
  );

  it('rejects expired payloads (explicit expiresAt, belt over seal ttl)', () => {
    expect(
      isSessionDataValid({ steamId: STEAM, expiresAt: Date.now() - 1000 }),
    ).toBe(false);
  });
});

describe('getSessionSteamId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'y'.repeat(40);
  });

  it('returns the verified id from a valid session', async () => {
    mockGetIronSession.mockResolvedValue({
      steamId: STEAM,
      expiresAt: Date.now() + 1000,
    });

    await expect(getSessionSteamId(makeStore())).resolves.toBe(STEAM);
  });

  it('returns null for empty, tampered, or expired sessions (never throws)', async () => {
    mockGetIronSession.mockResolvedValue({});
    await expect(getSessionSteamId(makeStore())).resolves.toBeNull();

    mockGetIronSession.mockResolvedValue({
      steamId: STEAM,
      expiresAt: Date.now() - 1000,
    });
    await expect(getSessionSteamId(makeStore())).resolves.toBeNull();

    mockGetIronSession.mockResolvedValue({
      steamId: 'short',
      expiresAt: Date.now() + 1000,
    });
    await expect(getSessionSteamId(makeStore())).resolves.toBeNull();
  });
});

describe('saveWatchSession / destroyWatchSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'y'.repeat(40);
  });

  it('writes id + expiry and saves', async () => {
    const save = jest.fn(async () => undefined);
    const session: Record<string, unknown> = { save };
    mockGetIronSession.mockResolvedValue(session);

    await saveWatchSession(makeStore(), STEAM);

    expect(session.steamId).toBe(STEAM);
    expect(typeof session.expiresAt).toBe('number');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('destroys the session on logout', async () => {
    const destroy = jest.fn(async () => undefined);
    mockGetIronSession.mockResolvedValue({ destroy });

    await destroyWatchSession(makeStore());

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('resolveWatchSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'y'.repeat(40);
  });

  it('resolves authenticated sessions to the id', async () => {
    mockGetIronSession.mockResolvedValue({
      steamId: STEAM,
      expiresAt: Date.now() + 1000,
    });

    await expect(resolveWatchSession(makeStore())).resolves.toEqual({
      status: 'authenticated',
      steamId: STEAM,
    });
  });

  it('resolves missing/invalid sessions to unauthenticated (not error)', async () => {
    mockGetIronSession.mockResolvedValue({});

    await expect(resolveWatchSession(makeStore())).resolves.toEqual({
      status: 'unauthenticated',
    });
  });

  it('surfaces session-layer failures distinctly (routes map these to loud 500s)', async () => {
    const failure = new Error('SESSION_SECRET exploded');
    mockGetIronSession.mockRejectedValue(failure);

    await expect(resolveWatchSession(makeStore())).resolves.toEqual({
      status: 'error',
      error: failure,
    });
  });
});

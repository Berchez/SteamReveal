/**
 * @jest-environment node
 */

import {
  clearPendingLogin,
  createPendingLoginData,
  getPendingLogin,
  isPendingLoginDataValid,
  savePendingLogin,
  PENDING_LOGIN_TTL_MS,
} from './pendingLogin';

jest.mock('iron-session', () => ({
  getIronSession: jest.fn(),
}));

import { getIronSession } from 'iron-session';

const mockGetIronSession = getIronSession as jest.Mock;

const STEAM = '76561198000000001';
const NEXT = '/pt/player/player-c';

const makeStore = () => ({
  get: jest.fn(),
  set: jest.fn(),
});

describe('createPendingLoginData / isPendingLoginDataValid', () => {
  it('creates a 30-minute tagged payload for a verified id', () => {
    const before = Date.now();
    const data = createPendingLoginData(STEAM, NEXT);

    expect(data.kind).toBe('pending-login');
    expect(data.steamId).toBe(STEAM);
    expect(data.next).toBe(NEXT);
    expect(data.expiresAt).toBeGreaterThan(
      before + PENDING_LOGIN_TTL_MS - 1000,
    );
    expect(data.expiresAt).toBeLessThanOrEqual(
      Date.now() + PENDING_LOGIN_TTL_MS,
    );
    expect(isPendingLoginDataValid(data)).toBe(true);
  });

  it('rejects malformed ids at creation', () => {
    expect(() => createPendingLoginData('short', NEXT)).toThrow(/17 digits/);
  });

  it.each([null, undefined, 'x', 42, {}, { steamId: STEAM }])(
    'rejects %p without throwing',
    (data) => {
      expect(isPendingLoginDataValid(data)).toBe(false);
    },
  );

  it('rejects empty next and expired payloads', () => {
    expect(
      isPendingLoginDataValid({
        kind: 'pending-login',
        steamId: STEAM,
        next: '',
        expiresAt: Date.now() + 1000,
      }),
    ).toBe(false);
    expect(
      isPendingLoginDataValid({
        kind: 'pending-login',
        steamId: STEAM,
        next: NEXT,
        expiresAt: Date.now() - 1000,
      }),
    ).toBe(false);
  });

  it.each([undefined, null, 'watch-session', 'pending-login '] as unknown[])(
    'rejects kind %p: cross-cookie replay is structurally impossible',
    (kind) => {
      expect(
        isPendingLoginDataValid({
          kind,
          steamId: STEAM,
          next: NEXT,
          expiresAt: Date.now() + 1000,
        }),
      ).toBe(false);
    },
  );
});

describe('getPendingLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'y'.repeat(40);
  });

  it('returns the verified pending identity from a valid cookie', async () => {
    mockGetIronSession.mockResolvedValue({
      kind: 'pending-login',
      steamId: STEAM,
      next: NEXT,
      expiresAt: Date.now() + 1000,
    });

    await expect(getPendingLogin(makeStore())).resolves.toEqual({
      kind: 'pending-login',
      steamId: STEAM,
      next: NEXT,
      expiresAt: expect.any(Number),
    });
  });

  it('returns null for empty, tampered, or expired cookies (never throws)', async () => {
    mockGetIronSession.mockResolvedValue({});
    await expect(getPendingLogin(makeStore())).resolves.toBeNull();

    mockGetIronSession.mockResolvedValue({
      kind: 'pending-login',
      steamId: STEAM,
      next: NEXT,
      expiresAt: Date.now() - 1000,
    });
    await expect(getPendingLogin(makeStore())).resolves.toBeNull();

    mockGetIronSession.mockResolvedValue({
      kind: 'pending-login',
      steamId: 'short',
      next: NEXT,
      expiresAt: Date.now() + 1000,
    });
    await expect(getPendingLogin(makeStore())).resolves.toBeNull();
  });

  it('returns null for a session-shaped value replayed under this cookie', async () => {
    // Same SESSION_SECRET, near-identical shape — without the kind gate
    // this would validate. The tag is what makes the shapes disjoint.
    mockGetIronSession.mockResolvedValue({
      steamId: STEAM,
      expiresAt: Date.now() + 1000,
    });
    await expect(getPendingLogin(makeStore())).resolves.toBeNull();
  });

  it('seals with httpOnly + SameSite=Lax (+Secure in prod): the CSRF-relevant attributes', async () => {
    const save = jest.fn();
    mockGetIronSession.mockResolvedValue({ save });

    await savePendingLogin(makeStore(), STEAM, NEXT);

    expect(mockGetIronSession).toHaveBeenCalledTimes(1);
    const options = mockGetIronSession.mock.calls[0][1] as {
      cookieName: string;
      cookieOptions: Record<string, unknown>;
    };
    expect(options.cookieName).toBe('steamreveal_pending_login');
    // Lax: cross-site subresource fetches never carry the cookie (so a
    // forged cross-site poll cannot spend someone else's wait), while
    // legitimate same-site navigation keeps working.
    expect(options.cookieOptions).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('returns null when the seal layer itself throws (rotated secret)', async () => {
    mockGetIronSession.mockRejectedValue(new Error('bad seal'));

    await expect(getPendingLogin(makeStore())).resolves.toBeNull();
  });
});

describe('savePendingLogin / clearPendingLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'y'.repeat(40);
  });

  it('seals the verified identity with the destination', async () => {
    const save = jest.fn();
    mockGetIronSession.mockResolvedValue({ save });

    await savePendingLogin(makeStore(), STEAM, NEXT);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('destroys the pending cookie', async () => {
    const destroy = jest.fn();
    mockGetIronSession.mockResolvedValue({ destroy });

    await clearPendingLogin(makeStore());

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

/**
 * @jest-environment node
 */

import { completeProvenLogin } from './completeLogin';

jest.mock('@/lib/analytics/db', () => ({
  ensureActiveWatch: jest.fn(),
  recordLogin: jest.fn(),
  enqueueEvent: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  saveWatchSession: jest.fn(),
}));

const { ensureActiveWatch, recordLogin, enqueueEvent } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  ensureActiveWatch: jest.Mock;
  recordLogin: jest.Mock;
  enqueueEvent: jest.Mock;
};
const { saveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  saveWatchSession: jest.Mock;
};

const STEAM = '76561198000000001';

const makeStore = () => ({
  get: jest.fn(),
  set: jest.fn(),
});

describe('completeProvenLogin (shared callback + pending completion)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureActiveWatch.mockResolvedValue({
      profile: { steamId: STEAM, status: 'active' },
      activated: false,
    });
    recordLogin.mockResolvedValue({});
    enqueueEvent.mockResolvedValue({ eventId: 1, duplicate: false });
    saveWatchSession.mockResolvedValue(undefined);
  });

  it('runs the load-bearing order once: ensure -> record -> seal (no welcome on repeat)', async () => {
    const result = await completeProvenLogin(
      makeStore(),
      STEAM,
      '/pt/player/player-c',
      'steamCallback',
    );

    expect(result).toEqual({ activated: false, locale: 'pt' });
    expect(ensureActiveWatch).toHaveBeenCalledTimes(1);
    expect(ensureActiveWatch).toHaveBeenCalledWith(STEAM, 'pt');
    expect(recordLogin).toHaveBeenCalledWith(STEAM, 'pt');
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('enqueues exactly ONE welcome when this call activated', async () => {
    ensureActiveWatch.mockResolvedValueOnce({
      profile: { steamId: STEAM, status: 'active' },
      activated: true,
    });

    const result = await completeProvenLogin(
      makeStore(),
      STEAM,
      '/en/',
      'steamPending',
    );

    expect(result).toEqual({ activated: true, locale: 'en' });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent).toHaveBeenCalledWith(STEAM, 'welcome');
  });

  it('resolves a null locale for unprefixed destinations', async () => {
    const result = await completeProvenLogin(makeStore(), STEAM, '/', 'x');

    expect(result.locale).toBeNull();
    expect(ensureActiveWatch).toHaveBeenCalledWith(STEAM, null);
  });

  it('a failed recordLogin never costs the completion (audit is non-fatal)', async () => {
    recordLogin.mockRejectedValueOnce(new Error('audit down'));

    const result = await completeProvenLogin(makeStore(), STEAM, '/pt/', 'x');

    expect(result.activated).toBe(false);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('a failed welcome enqueue is retried 3x and never costs the completion', async () => {
    ensureActiveWatch.mockResolvedValueOnce({
      profile: { steamId: STEAM, status: 'active' },
      activated: true,
    });
    enqueueEvent.mockRejectedValue(new Error('outbox down'));

    const result = await completeProvenLogin(makeStore(), STEAM, '/pt/', 'x');

    expect(result.activated).toBe(true);
    expect(enqueueEvent).toHaveBeenCalledTimes(3);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('an ensureActiveWatch failure is fatal (callers deny or keep waiting)', async () => {
    ensureActiveWatch.mockRejectedValueOnce(new Error('db down'));

    await expect(
      completeProvenLogin(makeStore(), STEAM, '/pt/', 'x'),
    ).rejects.toThrow('db down');
    expect(saveWatchSession).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('a session-seal failure is fatal (never report success unsealed)', async () => {
    saveWatchSession.mockRejectedValueOnce(new Error('cookie store down'));

    await expect(
      completeProvenLogin(makeStore(), STEAM, '/pt/', 'x'),
    ).rejects.toThrow('cookie store down');
  });

  it('seals BEFORE welcoming: a seal failure can never orphan a welcome', async () => {
    // Pinned order (ensure -> record -> seal -> welcome): the welcome must
    // not fire when the seal below it fails, or the user would hold a live
    // watch + welcome while the login reports an error.
    ensureActiveWatch.mockResolvedValueOnce({
      profile: { steamId: STEAM, status: 'active' },
      activated: true,
    });
    saveWatchSession.mockRejectedValueOnce(new Error('cookie store down'));

    await expect(
      completeProvenLogin(makeStore(), STEAM, '/pt/', 'x'),
    ).rejects.toThrow('cookie store down');
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});

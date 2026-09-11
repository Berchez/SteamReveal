/**
 * @jest-environment node
 */

import { enqueueWatchNotification } from './watchNotify';

jest.mock('./db', () => ({
  getWatchedProfile: jest.fn(),
  enqueueEvent: jest.fn(),
}));

const { getWatchedProfile, enqueueEvent } = jest.requireMock('./db') as {
  getWatchedProfile: jest.Mock;
  enqueueEvent: jest.Mock;
};

const STEAM = '76561198000000000';

const activeProfile = (overrides: Record<string, unknown> = {}) => ({
  steamId: STEAM,
  status: 'active',
  locale: null,
  requestedAt: '2026-06-01T00:00:00.000Z',
  activatedAt: '2026-06-01T01:00:00.000Z',
  lastNotifiedAt: null,
  ...overrides,
});

const silentLogger = { error: jest.fn() };

describe('enqueueWatchNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getWatchedProfile.mockResolvedValue(activeProfile());
    enqueueEvent.mockResolvedValue({ eventId: 7, duplicate: false });
  });

  it('enqueues a notify for an active watch outside cooldown', async () => {
    const result = await enqueueWatchNotification(
      STEAM,
      'search-1',
      silentLogger,
    );

    expect(result).toEqual({ enqueued: true, eventId: 7 });
    // One read for both gates (status + clock ride the same row).
    expect(getWatchedProfile).toHaveBeenCalledTimes(1);
    expect(getWatchedProfile).toHaveBeenCalledWith(STEAM);
    expect(enqueueEvent).toHaveBeenCalledWith(STEAM, 'notify', 'search-1');
    expect(silentLogger.error).not.toHaveBeenCalled();
  });

  it('skips watches that are not active (missing or pending)', async () => {
    getWatchedProfile.mockResolvedValueOnce(
      activeProfile({ status: 'pending' }),
    );
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'not-active' });

    getWatchedProfile.mockResolvedValueOnce(null);
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'not-active' });

    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('skips when the 24h cooldown is active (no new event row)', async () => {
    getWatchedProfile.mockResolvedValueOnce(
      activeProfile({ lastNotifiedAt: new Date().toISOString() }),
    );

    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'cooldown' });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('reports duplicate when the search already produced a notify', async () => {
    enqueueEvent.mockResolvedValueOnce({ eventId: 7, duplicate: true });

    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'duplicate' });
  });

  it('lets concurrent duplicate submits resolve (DAL owns the collapse)', async () => {
    // Both callers pass the gates; the DAL's UNIQUE(search_id) decides the
    // winner (proven against real SQL in db.integration.test.ts).
    enqueueEvent
      .mockResolvedValueOnce({ eventId: 9, duplicate: false })
      .mockResolvedValueOnce({ eventId: 9, duplicate: true });

    const [first, second] = await Promise.all([
      enqueueWatchNotification(STEAM, 'search-race', silentLogger),
      enqueueWatchNotification(STEAM, 'search-race', silentLogger),
    ]);

    expect(first).toEqual({ enqueued: true, eventId: 9 });
    expect(second).toEqual({ enqueued: false, reason: 'duplicate' });
  });

  it('never throws when the enqueue fails (analytics continues)', async () => {
    enqueueEvent.mockRejectedValueOnce(new Error('db down'));

    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'error' });
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
  });

  it('never throws when the profile read fails', async () => {
    getWatchedProfile.mockRejectedValueOnce(new Error('turso unreachable'));
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'error' });

    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
  });

  it('never throws on invalid ids (DAL assertion becomes error outcome)', async () => {
    getWatchedProfile.mockImplementationOnce(() => {
      throw new Error('Invalid SteamID64 for watch DAL: expected 17 digits');
    });

    await expect(
      enqueueWatchNotification('short', 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'error' });
  });

  it('logs failures with public ids only (no secrets flow through here)', async () => {
    enqueueEvent.mockRejectedValueOnce(new Error('db down'));

    await enqueueWatchNotification(STEAM, 'search-1', silentLogger);

    expect(silentLogger.error).toHaveBeenCalledTimes(1);
    const line = String(silentLogger.error.mock.calls[0][0]);
    expect(line).toContain(STEAM);
    expect(line).toContain('search-1');
    expect(line).not.toMatch(/password|secret|token/i);
  });
});

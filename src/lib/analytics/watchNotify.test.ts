/**
 * @jest-environment node
 */

import { enqueueWatchNotification } from './watchNotify';

jest.mock('./db', () => ({
  getWatchStatus: jest.fn(),
  isWithinCooldown: jest.fn(),
  enqueueEvent: jest.fn(),
}));

const { getWatchStatus, isWithinCooldown, enqueueEvent } = jest.requireMock(
  './db',
) as {
  getWatchStatus: jest.Mock;
  isWithinCooldown: jest.Mock;
  enqueueEvent: jest.Mock;
};

const STEAM = '76561198000000000';
const silentLogger = { error: jest.fn() };

describe('enqueueWatchNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getWatchStatus.mockResolvedValue('active');
    isWithinCooldown.mockResolvedValue(false);
    enqueueEvent.mockResolvedValue({ eventId: 7, duplicate: false });
  });

  it('enqueues a notify for an active watch outside cooldown', async () => {
    const result = await enqueueWatchNotification(
      STEAM,
      'search-1',
      silentLogger,
    );

    expect(result).toEqual({ enqueued: true, eventId: 7 });
    expect(getWatchStatus).toHaveBeenCalledWith(STEAM);
    expect(isWithinCooldown).toHaveBeenCalledWith(STEAM, 24);
    expect(enqueueEvent).toHaveBeenCalledWith(STEAM, 'notify', 'search-1');
    expect(silentLogger.error).not.toHaveBeenCalled();
  });

  it('skips watches that are not active (missing or pending)', async () => {
    getWatchStatus.mockResolvedValueOnce('pending');
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'not-active' });

    getWatchStatus.mockResolvedValueOnce(null);
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'not-active' });

    // The gates run concurrently (both read-only), so the cooldown read
    // fires even for inactive watches — but nothing is ever enqueued.
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('skips when the 24h cooldown is active (no new event row)', async () => {
    isWithinCooldown.mockResolvedValueOnce(true);

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

  it('never throws when a watch check fails (status or cooldown)', async () => {
    getWatchStatus.mockRejectedValueOnce(new Error('turso unreachable'));
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'error' });

    getWatchStatus.mockResolvedValueOnce('active');
    isWithinCooldown.mockRejectedValueOnce(new Error('turso unreachable'));
    await expect(
      enqueueWatchNotification(STEAM, 'search-1', silentLogger),
    ).resolves.toEqual({ enqueued: false, reason: 'error' });

    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(silentLogger.error).toHaveBeenCalledTimes(2);
  });

  it('never throws on invalid ids (DAL assertion becomes error outcome)', async () => {
    getWatchStatus.mockImplementationOnce(() => {
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

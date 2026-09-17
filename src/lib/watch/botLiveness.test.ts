/**
 * @jest-environment node
 */

import {
  BOT_DISCONNECTED_MAX_AGE_MS,
  BOT_LIVENESS_MEMO_MS,
  BOT_ONLINE_MAX_AGE_MS,
  clearBotLivenessMemo,
  isBotOnline,
} from './botLiveness';

jest.mock('@/lib/analytics/db', () => ({
  getBotHeartbeat: jest.fn(),
}));

import { getBotHeartbeat } from '@/lib/analytics/db';

const getBotHeartbeatMock = getBotHeartbeat as jest.Mock;

const beat = (
  beatAtIso: string,
  connected = true,
  disconnectedSince: string | null = null,
) => ({
  beatAt: beatAtIso,
  connected,
  steamId: '76561199000000001',
  disconnectedSince,
});

describe('isBotOnline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearBotLivenessMemo();
  });

  it('is online with a fresh beat', async () => {
    getBotHeartbeatMock.mockResolvedValue(
      beat(new Date(Date.now() - 1000).toISOString()),
    );

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('is offline only when the beat is demonstrably stale', async () => {
    getBotHeartbeatMock.mockResolvedValue(
      beat(
        new Date(Date.now() - BOT_ONLINE_MAX_AGE_MS - 1000).toISOString(),
      ),
    );

    await expect(isBotOnline()).resolves.toBe(false);
  });

  it('reports ONLINE on a fresh disconnected beat still inside the window (transient reconnect never hides the button)', async () => {
    getBotHeartbeatMock.mockResolvedValue(
      beat(
        new Date(Date.now() - 5000).toISOString(),
        false,
        new Date(Date.now() - BOT_DISCONNECTED_MAX_AGE_MS / 2).toISOString(),
      ),
    );

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('is offline on a fresh disconnected beat sustained past the window (process alive, Steam session dead)', async () => {
    getBotHeartbeatMock.mockResolvedValue(
      beat(
        new Date(Date.now() - 5000).toISOString(),
        false,
        new Date(
          Date.now() - BOT_DISCONNECTED_MAX_AGE_MS - 1000,
        ).toISOString(),
      ),
    );

    await expect(isBotOnline()).resolves.toBe(false);
  });

  it('fails open to ONLINE when connected=0 has no window clock (legacy row predating the column)', async () => {
    getBotHeartbeatMock.mockResolvedValue(
      beat(new Date(Date.now() - 1000).toISOString(), false, null),
    );

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('fails open to ONLINE on an unparseable disconnected_since (corrupt = unknown, not offline)', async () => {
    getBotHeartbeatMock.mockResolvedValue(
      beat(new Date(Date.now() - 1000).toISOString(), false, 'not-a-date'),
    );

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('fails open to ONLINE on a missing row (bot not deployed yet)', async () => {
    getBotHeartbeatMock.mockResolvedValue(null);

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('fails open to ONLINE when the DAL throws (unrelated blip never hides the button)', async () => {
    getBotHeartbeatMock.mockRejectedValue(new Error('turso down'));

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('fails open to ONLINE on an unparseable timestamp (corrupt = unknown, not offline)', async () => {
    getBotHeartbeatMock.mockResolvedValue(beat('not-a-date'));

    await expect(isBotOnline()).resolves.toBe(true);
  });

  it('memoizes the decision within the TTL (one read, then cached)', async () => {
    getBotHeartbeatMock.mockResolvedValue(beat(new Date().toISOString()));

    await isBotOnline();
    await isBotOnline();
    await isBotOnline();

    expect(getBotHeartbeatMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent reads at TTL expiry (one read, shared result)', async () => {
    let resolveRead: ((value: unknown) => void) | undefined;
    getBotHeartbeatMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    const first = isBotOnline();
    const second = isBotOnline();
    resolveRead?.(beat(new Date().toISOString()));

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(getBotHeartbeatMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the memo TTL expires (bot coming back is detected)', async () => {
    let now = Date.now();
    const realNow = Date.now;
    Date.now = jest.fn(() => now);
    try {
      getBotHeartbeatMock.mockResolvedValue(beat(new Date(now).toISOString()));
      await isBotOnline();
      expect(getBotHeartbeatMock).toHaveBeenCalledTimes(1);

      // Within TTL: cached.
      now += BOT_LIVENESS_MEMO_MS - 1000;
      await isBotOnline();
      expect(getBotHeartbeatMock).toHaveBeenCalledTimes(1);

      // Past TTL: re-read.
      now += 2000;
      await isBotOnline();
      expect(getBotHeartbeatMock).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('clearBotLivenessMemo forces the next read', async () => {
    getBotHeartbeatMock.mockResolvedValue(beat(new Date().toISOString()));
    await isBotOnline();
    await isBotOnline();
    expect(getBotHeartbeatMock).toHaveBeenCalledTimes(1);

    clearBotLivenessMemo();
    await isBotOnline();
    expect(getBotHeartbeatMock).toHaveBeenCalledTimes(2);
  });
});

import { getNotifyMessage } from './notifyMessage';
import {
  isNotifyExpired,
  isWithinNotificationCooldown,
  pollNotifyQueueOnce,
  startNotifyPoller,
} from './notifyPoller';

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const silentLogger = { info: jest.fn(), error: jest.fn() };

type FakeEvent = { id: number; steamId: string; createdAt: string };

const freshEvent = (id: number, steamId: string): FakeEvent => ({
  id,
  steamId,
  createdAt: new Date().toISOString(),
});

const agedEvent = (
  id: number,
  steamId: string,
  ageDays: number,
): FakeEvent => ({
  id,
  steamId,
  createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
});

const makeDal = () => ({
  claimNextQueuedEvents: jest.fn(async (): Promise<FakeEvent[]> => []),
  markEventSent: jest.fn(async (): Promise<boolean> => true),
  markEventDropped: jest.fn(async (): Promise<boolean> => true),
  recordEventAttempt: jest.fn(
    async (): Promise<'requeued' | 'dropped' | null> => 'requeued',
  ),
  getWatchedProfile: jest.fn(
    async (): Promise<{
      status: string;
      locale: string | null;
      lastNotifiedAt: string | null;
    } | null> => ({ status: 'active', locale: 'en', lastNotifiedAt: null }),
  ),
});

const makeChat = () => ({
  sendFriendMessage: jest.fn(async (): Promise<unknown> => ({ ordinal: 1 })),
});

describe('pollNotifyQueueOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims notifies, sends the localized message, marks sent', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([
      freshEvent(1, STEAM_A),
      freshEvent(2, STEAM_B),
    ]);
    dal.getWatchedProfile
      .mockResolvedValueOnce({
        status: 'active',
        locale: 'pt',
        lastNotifiedAt: null,
      })
      .mockResolvedValueOnce({
        status: 'active',
        locale: 'de',
        lastNotifiedAt: null,
      });

    const report = await pollNotifyQueueOnce({ chat, dal, logger });

    // Lane isolation: the notify poller only ever claims its own lane.
    expect(dal.claimNextQueuedEvents).toHaveBeenCalledWith('notify', 10);
    expect(report).toMatchObject({ claimed: 2, sent: 2, errors: [] });
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_A,
      getNotifyMessage('pt', STEAM_A),
    );
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_B,
      getNotifyMessage('de', STEAM_B),
    );
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0][0])).toContain('claimed=2');
  });

  it('skips the whole pass (no DAL, no Steam) when not connected', async () => {
    const dal = makeDal();
    const chat = makeChat();

    const report = await pollNotifyQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isConnected: () => false,
    });

    expect(report.skipped).toBe(true);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });

  it('fails fast on invalid maxAttempts/ttlDays', async () => {
    const dal = makeDal();
    const chat = makeChat();

    await expect(
      pollNotifyQueueOnce({ chat, dal, maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
    await expect(
      pollNotifyQueueOnce({ chat, dal, ttlDays: -1 }),
    ).rejects.toThrow(/ttlDays/);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
  });

  it('drops expired events without sending (bot was offline for days)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([agedEvent(1, STEAM_A, 8)]);

    const report = await pollNotifyQueueOnce({ chat, dal });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
    expect(dal.getWatchedProfile).not.toHaveBeenCalled();
  });

  it('sends events just inside the TTL and drops just outside it', async () => {
    const dal = makeDal();
    const chat = makeChat();
    // 6.9 days old: inside the 7-day window.
    dal.claimNextQueuedEvents.mockResolvedValueOnce([
      agedEvent(1, STEAM_A, 6.9),
    ]);
    const inside = await pollNotifyQueueOnce({ chat, dal });
    expect(inside).toMatchObject({ sent: 1, dropped: 0 });

    // 7 days + 1 minute: outside.
    dal.claimNextQueuedEvents.mockResolvedValueOnce([
      agedEvent(2, STEAM_B, 7 + 1 / 1440),
    ]);
    const outside = await pollNotifyQueueOnce({ chat, dal });
    expect(outside).toMatchObject({ sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
  });

  it('drops events with a corrupt created_at (fail toward no stale send)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([
      { id: 1, steamId: STEAM_A, createdAt: 'not-a-timestamp' },
    ]);

    const report = await pollNotifyQueueOnce({ chat, dal });

    expect(report).toMatchObject({ dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
  });

  it('drops events whose watch row is gone (opt-out) without sending', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    dal.getWatchedProfile.mockResolvedValue(null);

    const report = await pollNotifyQueueOnce({ chat, dal });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
  });

  it('drops events whose watch is no longer active', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    dal.getWatchedProfile.mockResolvedValue({
      status: 'pending',
      locale: null,
      lastNotifiedAt: null,
    });

    const report = await pollNotifyQueueOnce({ chat, dal });

    expect(report).toMatchObject({ dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });

  it('sends once per 24h window across a burst of queued searches', async () => {
    const dal = makeDal();
    const chat = makeChat();
    // Three rapid searches queued before the bot drained the lane: three
    // distinct events (different search_ids, no dedupe applies).
    dal.claimNextQueuedEvents.mockResolvedValue([
      freshEvent(1, STEAM_A),
      freshEvent(2, STEAM_A),
      freshEvent(3, STEAM_A),
    ]);
    // The first send advances last_notified_at (markEventSent does this in
    // the real DAL); the profile reads observe the moving clock.
    dal.getWatchedProfile
      .mockResolvedValueOnce({
        status: 'active',
        locale: 'en',
        lastNotifiedAt: null,
      })
      .mockResolvedValueOnce({
        status: 'active',
        locale: 'en',
        lastNotifiedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        status: 'active',
        locale: 'en',
        lastNotifiedAt: new Date().toISOString(),
      });

    const report = await pollNotifyQueueOnce({ chat, dal });

    // Exactly one Steam message for the whole burst — the rest are
    // cooldown-suppressed, not retried, not sent.
    expect(report).toMatchObject({ claimed: 3, sent: 1, dropped: 2 });
    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
    expect(dal.markEventDropped).toHaveBeenCalledWith(2);
    expect(dal.markEventDropped).toHaveBeenCalledWith(3);
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
  });

  it('falls back to English for unknown recipient locales', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    dal.getWatchedProfile.mockResolvedValue({
      status: 'active',
      locale: 'xx',
      lastNotifiedAt: null,
    });

    const report = await pollNotifyQueueOnce({ chat, dal });

    expect(report).toMatchObject({ sent: 1 });
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_A,
      getNotifyMessage('en', STEAM_A),
    );
  });

  it('retries a transient send failure and sends on the next pass', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('EChatTimeout'));

    const first = await pollNotifyQueueOnce({ chat, dal });
    expect(first).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    expect(dal.recordEventAttempt).toHaveBeenCalledWith(1, 3);

    // Next pass (requeued row claimed again): the send now works.
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    const second = await pollNotifyQueueOnce({ chat, dal });
    expect(second).toMatchObject({ sent: 1 });
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
  });

  it('drops after the attempt cap and logs loudly', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    chat.sendFriendMessage.mockRejectedValue(new Error('EChatTimeout'));
    dal.recordEventAttempt.mockResolvedValue('dropped');

    const report = await pollNotifyQueueOnce({ chat, dal, logger });

    expect(report).toMatchObject({ sent: 0, dropped: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain(STEAM_A);
  });

  it('keeps going after one bad event (per-row isolation)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([
      freshEvent(1, STEAM_A),
      freshEvent(2, STEAM_B),
    ]);
    // The profile read for A explodes; B must still send.
    dal.getWatchedProfile
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({
        status: 'active',
        locale: 'en',
        lastNotifiedAt: null,
      });

    const report = await pollNotifyQueueOnce({ chat, dal });

    expect(report).toMatchObject({ claimed: 2, sent: 1, retried: 1 });
    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_B,
      expect.any(String),
    );
  });

  it('counts (never sends-again) when the row leaves claimed state mid-send', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    dal.markEventSent.mockResolvedValue(false);

    const report = await pollNotifyQueueOnce({ chat, dal, logger });

    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ claimed: 1, sent: 0 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].message).toContain('claimed state');
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
  });

  it('records sent-but-unrecorded loudly when the settle write keeps failing', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([freshEvent(1, STEAM_A)]);
    dal.markEventSent.mockRejectedValue(new Error('turso timeout'));

    const report = await pollNotifyQueueOnce({ chat, dal, logger });

    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ sent: 0 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].message).toContain('sent but not recorded');
    // Exactly one chat send: the failure path must not requeue a re-send.
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
  });

  it('never leaks secrets into logs (only public ids are logged)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([
      freshEvent(1, STEAM_A),
      agedEvent(2, STEAM_B, 9),
    ]);
    chat.sendFriendMessage.mockRejectedValue(new Error('nope'));

    await pollNotifyQueueOnce({ chat, dal, logger });

    const lines = [
      ...logger.info.mock.calls.map((call) => String(call[0])),
      ...logger.error.mock.calls.map((call) => String(call[0])),
    ];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/password|shared[_-]?secret|auth[_-]?token/i);
    }
  });
});

describe('isWithinNotificationCooldown', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  it('is true inside the window and false at/past the boundary', () => {
    const recent = new Date(now - 23 * 60 * 60 * 1000).toISOString();
    const exactly24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const older = new Date(now - 25 * 60 * 60 * 1000).toISOString();

    expect(isWithinNotificationCooldown(recent, 24, now)).toBe(true);
    expect(isWithinNotificationCooldown(exactly24h, 24, now)).toBe(false);
    expect(isWithinNotificationCooldown(older, 24, now)).toBe(false);
  });

  it('fails open on missing or corrupt clocks (never suppresses forever)', () => {
    expect(isWithinNotificationCooldown(null, 24, now)).toBe(false);
    expect(isWithinNotificationCooldown(undefined, 24, now)).toBe(false);
    expect(isWithinNotificationCooldown('garbage', 24, now)).toBe(false);
    expect(isWithinNotificationCooldown('', 24, now)).toBe(false);
  });

  it('honors custom windows', () => {
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    expect(isWithinNotificationCooldown(twoHoursAgo, 24, now)).toBe(true);
    expect(isWithinNotificationCooldown(twoHoursAgo, 1, now)).toBe(false);
  });
});

describe('isNotifyExpired', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  it('expires past the TTL and keeps the boundary inclusive', () => {
    const exactly7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const over7d = new Date(now - 7 * 24 * 60 * 60 * 1000 - 1).toISOString();

    expect(isNotifyExpired(exactly7d, 7, now)).toBe(false);
    expect(isNotifyExpired(over7d, 7, now)).toBe(true);
  });

  it('expires corrupt timestamps (fail toward no stale send)', () => {
    expect(isNotifyExpired('garbage', 7, now)).toBe(true);
    expect(isNotifyExpired('', 7, now)).toBe(true);
  });

  it('honors custom TTL windows', () => {
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isNotifyExpired(twoDaysAgo, 7, now)).toBe(false);
    expect(isNotifyExpired(twoDaysAgo, 1, now)).toBe(true);
  });
});

describe('startNotifyPoller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not poll on start; polls on the interval until stopped', async () => {
    const dal = makeDal();
    const chat = makeChat();

    const handle = startNotifyPoller({
      chat,
      dal,
      pollIntervalMs: 60000,
    });
    try {
      expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();

      const pending = handle.pollOnce();
      await pending;
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(120000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(3);

      handle.stop();
      await jest.advanceTimersByTimeAsync(600000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(3);
    } finally {
      handle.stop();
    }
  });

  it('throws on an invalid interval (fail fast, no silent dead poller)', () => {
    const dal = makeDal();
    const chat = makeChat();

    expect(() => startNotifyPoller({ chat, dal, pollIntervalMs: 0 })).toThrow(
      /interval/,
    );
  });

  it('skips overlapping passes without stacking concurrent sends', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    // First pass hangs inside claim; the second pollOnce must skip.
    let releaseClaim!: (rows: FakeEvent[]) => void;
    dal.claimNextQueuedEvents.mockImplementation(
      () =>
        new Promise<FakeEvent[]>((resolve) => {
          releaseClaim = resolve;
        }),
    );

    const handle = startNotifyPoller({
      chat,
      dal,
      logger,
      pollIntervalMs: 60000,
    });
    try {
      const first = handle.pollOnce();
      const skipped = await handle.pollOnce();

      expect(skipped.skipped).toBe(true);
      expect(skipped.claimed).toBe(0);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      releaseClaim([freshEvent(1, STEAM_A)]);
      const report = await first;
      expect(report).toMatchObject({ claimed: 1, sent: 1 });
      expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });
});

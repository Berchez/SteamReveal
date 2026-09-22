/**
 * @jest-environment node
 *
 * Ban Reveal DAL unit tests (Phase 1): mirrors db.test.ts (offline
 * @libsql/client mock, node env) — success + edge + error cases for every
 * new ban-watch DAL function, including the fan-out-on-transition path
 * with multiple subscribers on one target.
 */

const mockBanCreateClient = jest.fn();

jest.mock('@libsql/client', () => ({
  createClient: mockBanCreateClient,
}));

const mockBanExecute = jest.fn().mockResolvedValue({ rows: [] });
const mockBanBatch = jest.fn().mockResolvedValue({});
const mockBanClose = jest.fn();

function buildMockBanClient(): void {
  mockBanCreateClient.mockReturnValue({
    execute: mockBanExecute,
    batch: mockBanBatch,
    close: mockBanClose,
  } as never);
}

const SUB = '76561198000000001';
const TARGET = '76561198000000002';
const SUB_B = '76561198000000003';

// Every first execute per fresh module is getClient's PRAGMA (cold start),
// so assertions below search all calls instead of indexing calls[0].
const executedSqls = (): string[] =>
  mockBanExecute.mock.calls.map((call) =>
    String(call[0]?.sql ?? call[0] ?? ''),
  );

describe('ban-watch DAL', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    mockBanCreateClient.mockClear();
    mockBanExecute.mockClear();
    mockBanBatch.mockClear();
    mockBanClose.mockClear();
    buildMockBanClient();
    // Cold-start PRAGMA placeholder: the first execute of every fresh
    // module is getClient's PRAGMA, so it must never eat a test's queued
    // row (same convention as db.test.ts).
    mockBanExecute.mockResolvedValueOnce({ rows: [] });
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.DATABASE_TOKEN = 'secret-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getSteamIdBySearchId resolves via the trusted profiles join', async () => {
    mockBanExecute.mockResolvedValueOnce({ rows: [{ steam_id: TARGET }] });
    const { getSteamIdBySearchId } = require('./db');
    await expect(getSteamIdBySearchId('search-1')).resolves.toBe(TARGET);
    expect(
      executedSqls().some((sql) =>
        sql.includes('FROM profiles WHERE search_id = ?'),
      ),
    ).toBe(true);
  });

  it('getSteamIdBySearchId returns null when the search is unknown', async () => {
    mockBanExecute.mockResolvedValueOnce({ rows: [] });
    const { getSteamIdBySearchId } = require('./db');
    await expect(getSteamIdBySearchId('missing')).resolves.toBeNull();
    await expect(getSteamIdBySearchId('')).rejects.toThrow(/searchId/);
  });

  it('ensureBanTarget inserts idempotently (steam source only)', async () => {
    mockBanExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    const { ensureBanTarget } = require('./db');
    await ensureBanTarget(TARGET);
    expect(
      executedSqls().some((sql) => sql.includes('INSERT INTO ban_watch_targets')),
    ).toBe(true);
    expect(
      executedSqls().some((sql) =>
        sql.includes('ON CONFLICT(target_steam_id, source) DO NOTHING'),
      ),
    ).toBe(true);
    await expect(ensureBanTarget('short')).rejects.toThrow(/17 digits/);
  });

  it('getBanTarget maps the row, null when never sighted', async () => {
    const { getBanTarget } = require('./db');
    mockBanExecute.mockResolvedValueOnce({
      rows: [
        {
          target_steam_id: TARGET,
          source: 'steam',
          last_known_banned: 1,
          last_ban_checked_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    await expect(getBanTarget(TARGET)).resolves.toMatchObject({
      targetSteamId: TARGET,
      lastKnownBanned: true,
      lastBanCheckedAt: '2026-01-01T00:00:00.000Z',
    });
    mockBanExecute.mockResolvedValueOnce({ rows: [] });
    await expect(getBanTarget(TARGET)).resolves.toBeNull();
    await expect(getBanTarget('bad')).rejects.toThrow(/17 digits/);
  });

  it('createBanSubscription sets notified_at immediately for pre-existing bans', async () => {
    mockBanExecute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            subscriber_steam_id: SUB,
            target_steam_id: TARGET,
            search_id: 's-1',
            subscribed_at: '2026-01-01T00:00:00.000Z',
            notified_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    const { createBanSubscription } = require('./db');
    const res = await createBanSubscription(SUB, TARGET, 's-1', true);
    expect(res.created).toBe(true);
    expect(res.subscription.notifiedAt).not.toBeNull();
    const insert = mockBanExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? '').includes(
        'INSERT INTO ban_watch_subscriptions',
      ),
    );
    expect(String(insert?.[0]?.sql ?? '')).toContain(
      'ON CONFLICT(subscriber_steam_id, target_steam_id) DO NOTHING',
    );
  });

  it('createBanSubscription leaves notified_at null for clean targets; re-open is a no-op', async () => {
    const { createBanSubscription } = require('./db');
    // Fresh subscribe: notified_at arg must be null.
    mockBanExecute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 8,
            subscriber_steam_id: SUB,
            target_steam_id: TARGET,
            search_id: 's-2',
            subscribed_at: '2026-01-02T00:00:00.000Z',
            notified_at: null,
          },
        ],
      });
    const fresh = await createBanSubscription(SUB, TARGET, 's-2', false);
    expect(fresh.created).toBe(true);
    expect(fresh.subscription.notifiedAt).toBeNull();
    const insert = mockBanExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? '').includes(
        'INSERT INTO ban_watch_subscriptions',
      ),
    );
    expect(insert?.[0]?.args?.[4]).toBeNull();

    // Re-open: 0-row insert still returns the existing row untouched.
    mockBanExecute.mockClear();
    mockBanExecute
      .mockResolvedValueOnce({ rowsAffected: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 8,
            subscriber_steam_id: SUB,
            target_steam_id: TARGET,
            search_id: 's-2',
            subscribed_at: '2026-01-02T00:00:00.000Z',
            notified_at: null,
          },
        ],
      });
    const again = await createBanSubscription(SUB, TARGET, 's-2', false);
    expect(again.created).toBe(false);
    expect(again.subscription.id).toBe(8);
  });

  it('listDistinctBanTargets reads steam-only, oldest-sighting first, clamped', async () => {
    mockBanExecute.mockResolvedValueOnce({
      rows: [{ target_steam_id: TARGET }, { target_steam_id: SUB_B }],
    });
    const { listDistinctBanTargets } = require('./db');
    await expect(listDistinctBanTargets(5)).resolves.toEqual([TARGET, SUB_B]);
    expect(
      executedSqls().some((sql) => sql.includes('WHERE source = ?')),
    ).toBe(true);
    expect(executedSqls().some((sql) => sql.includes('NULLS FIRST'))).toBe(
      true,
    );
    const scan = mockBanExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? '').includes('FROM ban_watch_targets'),
    );
    // Source travels as a bound arg (never interpolated), limit second.
    expect(scan?.[0]?.args).toEqual(['steam', 5]);
    await expect(listDistinctBanTargets(NaN)).rejects.toThrow(/finite/);
  });

  it('markBanTargetChecked flips the flag (unban never un-gates subscriptions by itself)', async () => {
    mockBanExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    const { markBanTargetChecked } = require('./db');
    await markBanTargetChecked(TARGET, true);
    expect(
      executedSqls().some((sql) => sql.includes('UPDATE ban_watch_targets')),
    ).toBe(true);
    const update = mockBanExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? '').includes('UPDATE ban_watch_targets'),
    );
    expect(update?.[0]?.args?.[0]).toBe(1);
    await expect(markBanTargetChecked('x', true)).rejects.toThrow(/17 digits/);
  });

  it('listUnnotifiedBanSubscriptions returns only ungated rows, oldest first', async () => {
    mockBanExecute.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          subscriber_steam_id: SUB,
          target_steam_id: TARGET,
          search_id: 's-1',
          subscribed_at: '2026-01-01T00:00:00.000Z',
          notified_at: null,
        },
        {
          id: 2,
          subscriber_steam_id: SUB_B,
          target_steam_id: TARGET,
          search_id: 's-2',
          subscribed_at: '2026-01-02T00:00:00.000Z',
          notified_at: null,
        },
      ],
    });
    const { listUnnotifiedBanSubscriptions } = require('./db');
    const subs = await listUnnotifiedBanSubscriptions(TARGET);
    expect(subs.map((s: { id: number }) => s.id)).toEqual([1, 2]);
    expect(
      executedSqls().some((sql) => sql.includes('notified_at IS NULL')),
    ).toBe(true);
  });

  it('enqueueBanAlertForSubscription gates + enqueues atomically (race loses)', async () => {
    const { enqueueBanAlertForSubscription } = require('./db');
    mockBanBatch.mockResolvedValueOnce([
      { lastInsertRowid: 99 },
      { rowsAffected: 1 },
    ]);
    await expect(
      enqueueBanAlertForSubscription(1, SUB),
    ).resolves.toMatchObject({ enqueued: true, eventId: 99 });
    const batch = mockBanBatch.mock.calls[0][0];
    expect(String(batch[0].sql)).toContain("'ban_alert'");
    // Ban events carry NULL search_id in SQL (UNIQUE(search_id) already
    // belongs to any notify for the originating search); the subscriber
    // travels as steam_id.
    expect(String(batch[0].sql)).toContain('VALUES (NULL, ?');
    expect(batch[0].args[0]).toBe(SUB);
    expect(String(batch[1].sql)).toContain('notified_at IS NULL');

    // Concurrent worker won first: gate misses, no alert counted.
    mockBanBatch.mockResolvedValueOnce([
      { lastInsertRowid: 100 },
      { rowsAffected: 0 },
    ]);
    await expect(
      enqueueBanAlertForSubscription(1, SUB),
    ).resolves.toMatchObject({ enqueued: false });
    await expect(
      enqueueBanAlertForSubscription(0, SUB),
    ).rejects.toThrow(/subscription id/);
  });

  it('getBanSubscription* authorize the reveal click; inbox stream stays generic', async () => {
    const {
      getBanSubscription,
      getBanSubscriptionById,
      listBanAlertsForSubscriber,
    } = require('./db');
    mockBanExecute.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          subscriber_steam_id: SUB,
          target_steam_id: TARGET,
          search_id: 's-9',
          subscribed_at: '2026-01-01T00:00:00.000Z',
          notified_at: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    await expect(getBanSubscription(SUB, TARGET)).resolves.toMatchObject({
      id: 3,
      targetSteamId: TARGET,
    });
    mockBanExecute.mockResolvedValueOnce({ rows: [] });
    await expect(getBanSubscription(SUB, TARGET)).resolves.toBeNull();

    mockBanExecute.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          subscriber_steam_id: SUB,
          target_steam_id: TARGET,
          search_id: 's-9',
          subscribed_at: '2026-01-01T00:00:00.000Z',
          notified_at: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    await expect(getBanSubscriptionById(3)).resolves.toMatchObject({ id: 3 });
    await expect(getBanSubscriptionById(0)).rejects.toThrow(/subscription id/);

    mockBanExecute.mockResolvedValueOnce({
      rows: [
        { id: 3, subscribed_at: '2026-01-01T00:00:00.000Z', notified_at: '2026-02-01T00:00:00.000Z' },
      ],
    });
    const alerts = await listBanAlertsForSubscriber(SUB);
    expect(alerts).toEqual([
      {
        id: 3,
        subscribedAt: '2026-01-01T00:00:00.000Z',
        notifiedAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    // Generic by design: no target steamId key travels in this stream.
    expect(alerts[0]).not.toHaveProperty('targetSteamId');
    expect(alerts[0]).not.toHaveProperty('subscriberSteamId');
  });

  it('recordBanRevealClick appends the instrumentation row', async () => {
    mockBanExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    const { recordBanRevealClick } = require('./db');
    await recordBanRevealClick(SUB, TARGET);
    expect(
      executedSqls().some((sql) =>
        sql.includes('INSERT INTO ban_watch_reveals'),
      ),
    ).toBe(true);
  });

  it('getBanSubscriberState: null without rows; watch locale wins over account', async () => {
    const { getBanSubscriberState } = require('./db');
    mockBanExecute.mockResolvedValueOnce({ rows: [] });
    await expect(getBanSubscriberState(SUB)).resolves.toBeNull();

    mockBanExecute.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    mockBanBatch.mockResolvedValueOnce([
      { rows: [{ locale: 'pt' }] },
      { rows: [{ locale: 'de' }] },
    ]);
    await expect(getBanSubscriberState(SUB)).resolves.toEqual({
      locale: 'pt',
    });

    mockBanExecute.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    mockBanBatch.mockResolvedValueOnce([{ rows: [] }, { rows: [] }]);
    await expect(getBanSubscriberState(SUB)).resolves.toEqual({
      locale: null,
    });
  });

  it('assertWatchEventKind accepts ban_alert (outbox lane)', async () => {
    mockBanExecute.mockResolvedValueOnce({ rows: [] });
    const { enqueueEvent } = require('./db');
    const res = await enqueueEvent(SUB, 'ban_alert', null);
    expect(res.duplicate).toBe(false);
    expect(
      executedSqls().some((sql) => sql.includes('INSERT INTO watch_events')),
    ).toBe(true);
    await expect(enqueueEvent('bad', 'ban_alert')).rejects.toThrow(/17 digits/);
  });
});

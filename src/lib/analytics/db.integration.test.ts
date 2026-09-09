/**
 * @jest-environment node
 */

/**
 * Real-SQL integration coverage for the Turso DAL.
 *
 * db.test.ts mocks @libsql/client, so it can never catch a typo'd column, a
 * broken FK, or a statement that only fails against a real engine. This file
 * runs the actual 001_init.sql schema on a real embedded libSQL engine
 * (`file::memory:`) and exercises recordSearch → getSearchRecords →
 * attachCheaterProbability for real — plus ON DELETE CASCADE, which is only
 * observable with a live database and FK enforcement on.
 *
 * Important: this file must NOT mock '@libsql/client'. The migration is
 * applied THROUGH db.ts's own memoized client (executeForTests), so the
 * schema, the writes and the reads all share one connection and one database.
 *
 * The module is never reset here: the client stays alive for the whole suite
 * and each test starts from a clean slate (beforeEach deletes searches, which
 * cascades into every child table and re-exercises the FK at the same time).
 */
import fs from 'fs';
import path from 'path';

import splitSqlStatements from './sqlStatements';

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '001_init.sql'),
  'utf8',
);

const WATCH_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '002_watch_bot.sql'),
  'utf8',
);

// In-memory: one connection, one database, nothing to clean up afterwards.
const DATABASE_URL = 'file::memory:';

jest.setTimeout(30000);

type DbApi = {
  executeForTests: (
    sql: string,
    args?: (string | number | null)[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  closeClientForTests: () => Promise<void>;
  recordSearch: typeof import('./db').recordSearch;
  getSearchRecords: typeof import('./db').getSearchRecords;
  attachCheaterProbability: typeof import('./db').attachCheaterProbability;
  createWatchRequest: typeof import('./db').createWatchRequest;
  activateWatch: typeof import('./db').activateWatch;
  deactivateWatch: typeof import('./db').deactivateWatch;
  getWatchStatus: typeof import('./db').getWatchStatus;
  listWatchedProfiles: typeof import('./db').listWatchedProfiles;
  enqueueEvent: typeof import('./db').enqueueEvent;
  claimNextQueuedEvents: typeof import('./db').claimNextQueuedEvents;
  markEventSent: typeof import('./db').markEventSent;
  markEventDropped: typeof import('./db').markEventDropped;
  resetStaleClaims: typeof import('./db').resetStaleClaims;
  isWithinCooldown: typeof import('./db').isWithinCooldown;
};

describe('analytics db integration against real libSQL', () => {
  const originalEnv = { ...process.env };
  let db: DbApi;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    delete process.env.DATABASE_TOKEN;

    db = require('./db') as DbApi;
    for (const statement of splitSqlStatements(MIGRATION_SQL)) {
      await db.executeForTests(statement);
    }
    // Epic 1 tables under test below. Applied exactly like production does
    // (fresh file through the same splitter), so a syntax slip in
    // 002_watch_bot.sql fails here, not on Turso.
    for (const statement of splitSqlStatements(WATCH_MIGRATION_SQL)) {
      await db.executeForTests(statement);
    }
  });

  beforeEach(async () => {
    // Wipe the previous test's rows (cascades into every child table via FK).
    await db.executeForTests('DELETE FROM searches');
    // Watch tables have no FKs by design (events survive opt-out deletes),
    // so they need their own wipe.
    await db.executeForTests('DELETE FROM watch_events');
    await db.executeForTests('DELETE FROM watched_profiles');
  });

  afterAll(async () => {
    await db.closeClientForTests();
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.DATABASE_TOKEN = originalEnv.DATABASE_TOKEN;
  });

  it('recordSearch → getSearchRecords round-trips the full record', async () => {
    const record = await db.recordSearch({
      profile: {
        steamId: '76561198000000000',
        nickname: 'IntegrationTester',
        cityId: 2786,
      },
      friends: [
        {
          steamId: '76561198000000001',
          nickname: 'F1',
          mutualCount: 3,
          probability: 87.5,
          countryCode: 'US',
        },
      ],
      gamesSnapshot: [{ name: 'Counter-Strike 2', playtimeHours: 120.5 }],
      locationGuess: [
        { location: { cityName: 'Sao Paulo', countryCode: 'BR' }, probability: 0.93 },
      ],
      isCSActive: true,
      requesterLocale: 'pt',
      requesterCountry: 'BR',
      requesterBrowserLanguage: 'pt-BR',
      device: 'desktop',
      durationMs: 500,
    });

    const [read] = await db.getSearchRecords();

    expect(read.id).toBe(record.id);
    expect(read.searchedAt).toBe(record.searchedAt);
    expect(read.profile).toEqual({
      steamId: '76561198000000000',
      steamUrl: null,
      nickname: 'IntegrationTester',
      gcName: null,
      countryCode: null,
      stateCode: null,
      cityId: '2786',
    });
    expect(read.isCSActive).toBe(true);
    expect(read.device).toBe('desktop');
    expect(read.durationMs).toBe(500);
    expect(read.requesterLocale).toBe('pt');
    expect(read.requesterCountry).toBe('BR');
    expect(read.requesterBrowserLanguage).toBe('pt-BR');
    expect(read.friends).toEqual([
      {
        steamId: '76561198000000001',
        nickname: 'F1',
        gcName: null,
        mutualCount: 3,
        probability: 87.5,
        countryCode: 'US',
      },
    ]);
    expect(read.gamesSnapshot).toEqual([
      { name: 'Counter-Strike 2', playtimeHours: 120.5 },
    ]);
    expect(read.locationGuess).toEqual([
      { location: { cityName: 'Sao Paulo', countryCode: 'BR' }, probability: 0.93 },
    ]);
    expect(read.cheater).toBeNull();
  });

  it('attachCheaterProbability upserts on the real schema', async () => {
    const record = await db.recordSearch({
      profile: { steamId: '76561198000000000' },
      friends: [],
    });

    const attached = await db.attachCheaterProbability(record.id, {
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2026-09-05T00:00:00.000Z',
    });
    expect(attached).toBe(true);

    const [withCheater] = await db.getSearchRecords();
    expect(withCheater.cheater).toEqual({
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2026-09-05T00:00:00.000Z',
    });

    const reattached = await db.attachCheaterProbability(record.id, {
      score: 80,
      bannedFriendsCount: 2,
      computedAt: '2026-09-05T01:00:00.000Z',
    });
    expect(reattached).toBe(true);

    const [afterUpsert] = await db.getSearchRecords();
    expect(afterUpsert.cheater).toEqual({
      score: 80,
      bannedFriendsCount: 2,
      computedAt: '2026-09-05T01:00:00.000Z',
    });

    expect(
      await db.attachCheaterProbability('missing-search-id', {
        score: 1,
        bannedFriendsCount: null,
        computedAt: '2026-09-05T02:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('ON DELETE CASCADE removes child rows from the real engine', async () => {
    const record = await db.recordSearch({
      profile: { steamId: '76561198000000000', nickname: 'CascadeMe' },
      friends: [{ steamId: '76561198000000001', nickname: 'F1' }],
      gamesSnapshot: [{ name: 'CS2', playtimeHours: 1 }],
      locationGuess: [
        { location: { cityName: 'X', countryCode: 'BR' }, probability: 0.5 },
      ],
      isCSActive: true,
    });
    await db.attachCheaterProbability(record.id, {
      score: 50,
      computedAt: '2026-09-05T00:00:00.000Z',
    });

    const childCount = async (table: string): Promise<number> => {
      const result = await db.executeForTests(
        `SELECT COUNT(*) AS n FROM ${table} WHERE search_id = ?`,
        [record.id],
      );
      return Number(result.rows[0].n);
    };

    for (const table of [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ]) {
      expect(await childCount(table)).toBeGreaterThan(0);
    }

    await db.executeForTests('DELETE FROM searches WHERE id = ?', [record.id]);

    for (const table of [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ]) {
      expect(await childCount(table)).toBe(0);
    }

    const remaining = await db.executeForTests('SELECT COUNT(*) AS n FROM searches');
    expect(Number(remaining.rows[0].n)).toBe(0);
  });

  describe('watch/outbox against real libSQL (Epic 1)', () => {
    const STEAM = '76561198000000001';

    it('runs the full watch lifecycle on real SQL', async () => {
      const created = await db.createWatchRequest(STEAM, 'pt');
      expect(created).toMatchObject({ steamId: STEAM, status: 'pending' });
      expect(await db.getWatchStatus(STEAM)).toBe('pending');

      // Duplicate request returns the same pending row, no second row.
      await db.createWatchRequest(STEAM, 'en');
      const count = await db.executeForTests(
        'SELECT COUNT(*) AS n FROM watched_profiles WHERE steam_id = ?',
        [STEAM],
      );
      expect(Number(count.rows[0].n)).toBe(1);

      expect(await db.activateWatch(STEAM)).toBe(true);
      expect(await db.getWatchStatus(STEAM)).toBe('active');

      const first = await db.enqueueEvent(STEAM, 'notify', 'search-9');
      expect(first.duplicate).toBe(false);
      const second = await db.enqueueEvent(STEAM, 'notify', 'search-9');
      expect(second).toEqual({ eventId: first.eventId, duplicate: true });

      const claimed = await db.claimNextQueuedEvents('notify', 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        steamId: STEAM,
        kind: 'notify',
        status: 'claimed',
        searchId: 'search-9',
      });

      // Claimed rows are invisible to the next poller (no double delivery).
      await expect(db.claimNextQueuedEvents('notify', 10)).resolves.toEqual(
        [],
      );

      expect(await db.markEventSent(claimed[0].id)).toBe(true);
      expect(await db.isWithinCooldown(STEAM, 24)).toBe(true);

      // Move the clock back 25h directly: outside a 24h window again.
      await db.executeForTests(
        "UPDATE watched_profiles SET last_notified_at = '2000-01-01T00:00:00.000Z' WHERE steam_id = ?",
        [STEAM],
      );
      expect(await db.isWithinCooldown(STEAM, 24)).toBe(false);
    });

    it('a duplicate markEventSent does not push the cooldown forward again', async () => {
      // Regression: the cooldown UPDATE used to match on id+kind alone, so
      // a second (idempotent-retry) markEventSent returned false yet still
      // bumped last_notified_at. It must be a pure no-op now.
      await db.createWatchRequest(STEAM);
      await db.enqueueEvent(STEAM, 'notify', 'search-double-send');
      const [claimed] = await db.claimNextQueuedEvents('notify', 10);

      expect(await db.markEventSent(claimed.id)).toBe(true);
      const afterFirst = await db.executeForTests(
        'SELECT last_notified_at AS n FROM watched_profiles WHERE steam_id = ?',
        [STEAM],
      );

      expect(await db.markEventSent(claimed.id)).toBe(false);
      const afterSecond = await db.executeForTests(
        'SELECT last_notified_at AS n FROM watched_profiles WHERE steam_id = ?',
        [STEAM],
      );
      expect(afterSecond.rows[0].n).toBe(afterFirst.rows[0].n);
    });

    it('markEventSent on a never-claimed event records no cooldown', async () => {
      await db.createWatchRequest(STEAM);
      await db.enqueueEvent(STEAM, 'notify', 'search-never-claimed');

      const pending = await db.executeForTests(
        'SELECT id FROM watch_events WHERE search_id = ?',
        ['search-never-claimed'],
      );
      const id = Number(pending.rows[0].id);

      // Still queued: nothing was sent, so the call fails AND the clock stays null.
      expect(await db.markEventSent(id)).toBe(false);
      expect(await db.isWithinCooldown(STEAM, 24)).toBe(false);
    });

    it('concurrent claims never deliver the same row twice', async () => {
      await db.createWatchRequest(STEAM);
      await db.enqueueEvent(STEAM, 'notify', 'search-c1');
      await db.enqueueEvent(STEAM, 'notify', 'search-c2');

      // Two pollers racing on real SQL: the atomic UPDATE...RETURNING gives
      // each row to exactly one winner (order between winners is unspecified).
      const [first, second] = await Promise.all([
        db.claimNextQueuedEvents('notify', 10),
        db.claimNextQueuedEvents('notify', 10),
      ]);
      const ids = [...first, ...second].map((e) => e.id).sort((a, b) => a - b);

      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it('concurrent enqueues for the same search collapse to one row + duplicate', async () => {
      // Fires both enqueues without awaiting in between: on real SQL at
      // least the loser path (UNIQUE catch backstop, not just the
      // pre-check) gets exercised against a genuine constraint violation,
      // proving the catch recognizes the engine's real error shape.
      await db.createWatchRequest(STEAM);
      const [first, second] = await Promise.all([
        db.enqueueEvent(STEAM, 'notify', 'search-race-real'),
        db.enqueueEvent(STEAM, 'notify', 'search-race-real'),
      ]);

      const queued = [first, second].filter((r) => !r.duplicate);
      const dups = [first, second].filter((r) => r.duplicate);
      expect(queued).toHaveLength(1);
      expect(dups).toHaveLength(1);
      expect(dups[0].eventId).toBe(queued[0].eventId);

      const count = await db.executeForTests(
        'SELECT COUNT(*) AS n FROM watch_events WHERE search_id = ?',
        ['search-race-real'],
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });

    it('allows many NULL search_ids (invites) while rejecting a repeated one', async () => {
      await db.createWatchRequest(STEAM);

      const a = await db.enqueueEvent(STEAM, 'invite');
      const b = await db.enqueueEvent(STEAM, 'invite');
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(false);
      expect(a.eventId).not.toBe(b.eventId);

      // ...but a repeated non-null search_id is still a duplicate.
      await db.enqueueEvent(STEAM, 'notify', 'search-dup');
      const dup = await db.enqueueEvent(STEAM, 'notify', 'search-dup');
      expect(dup.duplicate).toBe(true);
    });

    it('requeues orphaned claims and leaves fresh ones alone', async () => {
      await db.createWatchRequest(STEAM);
      const { eventId } = await db.enqueueEvent(STEAM, 'invite');
      const [claimed] = await db.claimNextQueuedEvents('invite', 10);

      // Age this claim past the window directly (a real crash leaves it here).
      await db.executeForTests(
        "UPDATE watch_events SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        [claimed.id],
      );
      expect(eventId).toBe(claimed.id);

      expect(await db.resetStaleClaims(30)).toBe(1);
      const reclaimed = await db.claimNextQueuedEvents('invite', 10);
      expect(reclaimed).toHaveLength(1);

      // A freshly claimed row is NOT stale.
      expect(await db.resetStaleClaims(30)).toBe(0);
    });

    it('opt-out deletes the profile row but keeps the event log (no FK)', async () => {
      await db.createWatchRequest(STEAM);
      await db.enqueueEvent(STEAM, 'invite');

      expect(await db.deactivateWatch(STEAM)).toBe(true);
      expect(await db.getWatchStatus(STEAM)).toBeNull();
      expect(await db.deactivateWatch(STEAM)).toBe(false);

      const events = await db.executeForTests(
        'SELECT COUNT(*) AS n FROM watch_events WHERE steam_id = ?',
        [STEAM],
      );
      expect(Number(events.rows[0].n)).toBe(1);
    });

    it('re-applying 002 is a safe no-op (IF NOT EXISTS idempotency)', async () => {
      for (const statement of splitSqlStatements(WATCH_MIGRATION_SQL)) {
        await db.executeForTests(statement);
      }

      // ...and the tables still work afterwards.
      await db.createWatchRequest(STEAM);
      expect(await db.getWatchStatus(STEAM)).toBe('pending');
    });

    it('listWatchedProfiles round-trips rows oldest-first, with and without filter', async () => {
      await db.createWatchRequest('76561198000000001', 'en');
      await db.createWatchRequest('76561198000000002', 'pt');
      await db.activateWatch('76561198000000002');

      const all = await db.listWatchedProfiles();
      expect(all.map((w) => w.steamId)).toEqual([
        '76561198000000001',
        '76561198000000002',
      ]);

      const active = await db.listWatchedProfiles('active');
      expect(active.map((w) => w.steamId)).toEqual(['76561198000000002']);

      const pending = await db.listWatchedProfiles('pending');
      expect(pending.map((w) => w.steamId)).toEqual(['76561198000000001']);
    });
  });
});
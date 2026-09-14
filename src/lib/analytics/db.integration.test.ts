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

const WATCH_ATTEMPTS_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '003_watch_attempts.sql'),
  'utf8',
);

const WATCH_INVITE_UNIQUE_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '004_watch_invite_open_unique.sql'),
  'utf8',
);

const WATCH_ACCOUNTS_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '005_watch_accounts.sql'),
  'utf8',
);

const WATCH_TOKEN_UNIQUE_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '006_accounts_confirm_token_unique.sql'),
  'utf8',
);

const WATCH_EXPIRE_NOTICE_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '008_accounts_expire_notice.sql'),
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
  removeWatchAndAccount: typeof import('./db').removeWatchAndAccount;
  deleteAccount: typeof import('./db').deleteAccount;
  getWatchStatus: typeof import('./db').getWatchStatus;
  getWatchedProfile: typeof import('./db').getWatchedProfile;
  hasOpenInviteEvent: typeof import('./db').hasOpenInviteEvent;
  refreshWatchRequest: typeof import('./db').refreshWatchRequest;
  recordEventAttempt: typeof import('./db').recordEventAttempt;
  listWatchedProfiles: typeof import('./db').listWatchedProfiles;
  enqueueEvent: typeof import('./db').enqueueEvent;
  claimNextQueuedEvents: typeof import('./db').claimNextQueuedEvents;
  markEventSent: typeof import('./db').markEventSent;
  markEventDropped: typeof import('./db').markEventDropped;
  resetStaleClaims: typeof import('./db').resetStaleClaims;
  countInvitesSentSince: typeof import('./db').countInvitesSentSince;
  countNotificationsSince: typeof import('./db').countNotificationsSince;
  listSentNotifications: typeof import('./db').listSentNotifications;
  isWithinCooldown: typeof import('./db').isWithinCooldown;
  hashConfirmToken: typeof import('./db').hashConfirmToken;
  createAccount: typeof import('./db').createAccount;
  getAccount: typeof import('./db').getAccount;
  issueConfirmToken: typeof import('./db').issueConfirmToken;
  consumeConfirmToken: typeof import('./db').consumeConfirmToken;
  getAccountByConfirmTokenHash: typeof import('./db').getAccountByConfirmTokenHash;
  listExpiredUnnoticedConfirms: typeof import('./db').listExpiredUnnoticedConfirms;
  markExpireNoticed: typeof import('./db').markExpireNoticed;
};

/**
 * Drives a profile through the full click-to-activate chain on real SQL:
 * account + pending watch + issued token, consumed immediately. After
 * this, activateWatch passes the confirmation gate. Idempotent pieces
 * (INSERT OR IGNORE / DO NOTHING) make it safe to call on rows the test
 * already created; issue overwrites any outstanding token by design.
 */
const confirmProfileForTests = async (
  api: Pick<
    DbApi,
    | 'createAccount'
    | 'createWatchRequest'
    | 'issueConfirmToken'
    | 'consumeConfirmToken'
    | 'hashConfirmToken'
  >,
  steamId: string,
): Promise<void> => {
  await api.createAccount(steamId);
  await api.createWatchRequest(steamId);
  const token = `confirm-${steamId}`;
  await api.issueConfirmToken(
    steamId,
    api.hashConfirmToken(token),
    '2030-01-01T00:00:00.000Z',
  );
  await api.consumeConfirmToken(api.hashConfirmToken(token));
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
    for (const statement of splitSqlStatements(WATCH_ATTEMPTS_MIGRATION_SQL)) {
      await db.executeForTests(statement);
    }
    for (const statement of splitSqlStatements(
      WATCH_INVITE_UNIQUE_MIGRATION_SQL,
    )) {
      await db.executeForTests(statement);
    }
    for (const statement of splitSqlStatements(
      WATCH_ACCOUNTS_MIGRATION_SQL,
    )) {
      await db.executeForTests(statement);
    }
    for (const statement of splitSqlStatements(
      WATCH_TOKEN_UNIQUE_MIGRATION_SQL,
    )) {
      await db.executeForTests(statement);
    }
    // 008 carries the expiry-notice marker column (validated on a real
    // engine here, like every migration above).
    for (const statement of splitSqlStatements(
      WATCH_EXPIRE_NOTICE_MIGRATION_SQL,
    )) {
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
    await db.executeForTests('DELETE FROM accounts');
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
        {
          location: { cityName: 'Sao Paulo', countryCode: 'BR' },
          probability: 0.93,
        },
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
      {
        location: { cityName: 'Sao Paulo', countryCode: 'BR' },
        probability: 0.93,
      },
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

    const remaining = await db.executeForTests(
      'SELECT COUNT(*) AS n FROM searches',
    );
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

      // Click-to-activate gate: the lifecycle needs a confirmed account.
      await confirmProfileForTests(db, STEAM);
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
      await expect(db.claimNextQueuedEvents('notify', 10)).resolves.toEqual([]);

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

    it('concurrent invite enqueues collapse to one open row + duplicate', async () => {
      // Same shape as the notify race above, but for the invite lane: both
      // submissions fly without awaiting in between, so on real SQL the
      // partial-unique-index catch backstop (not just the pre-check) is
      // exercised against a genuine engine constraint violation.
      await db.createWatchRequest(STEAM);
      const [first, second] = await Promise.all([
        db.enqueueEvent(STEAM, 'invite'),
        db.enqueueEvent(STEAM, 'invite'),
      ]);

      const created = [first, second].filter((r) => !r.duplicate);
      const dups = [first, second].filter((r) => r.duplicate);
      expect(created).toHaveLength(1);
      expect(dups).toHaveLength(1);
      expect(dups[0].eventId).toBe(created[0].eventId);

      const count = await db.executeForTests(
        "SELECT COUNT(*) AS n FROM watch_events WHERE steam_id = ? AND kind = 'invite' AND status IN ('queued', 'claimed')",
        [STEAM],
      );
      expect(Number(count.rows[0].n)).toBe(1);
      expect(await db.hasOpenInviteEvent(STEAM)).toBe(true);
    });

    it('countInvitesSentSince counts only sent invites at/after the boundary', async () => {
      await db.createWatchRequest(STEAM);
      expect(await db.countInvitesSentSince('2000-01-01T00:00:00.000Z')).toBe(
        0,
      );

      const { eventId } = await db.enqueueEvent(STEAM, 'invite');
      const [claimed] = await db.claimNextQueuedEvents('invite', 10);
      expect(claimed.id).toBe(eventId);
      // Queued-but-unsent does not count.
      expect(await db.countInvitesSentSince('2000-01-01T00:00:00.000Z')).toBe(
        0,
      );

      expect(await db.markEventSent(claimed.id)).toBe(true);
      expect(await db.countInvitesSentSince('2000-01-01T00:00:00.000Z')).toBe(
        1,
      );
      // A boundary after the send excludes it (ISO comparison is exact).
      expect(await db.countInvitesSentSince('2999-01-01T00:00:00.000Z')).toBe(
        0,
      );
    });

    it('collapses sequential duplicate invites while one is still open', async () => {
      await db.createWatchRequest(STEAM);

      const first = await db.enqueueEvent(STEAM, 'invite');
      expect(first.duplicate).toBe(false);

      // Same profile, invite still queued/claimed: no second row.
      const second = await db.enqueueEvent(STEAM, 'invite');
      expect(second).toEqual({ eventId: first.eventId, duplicate: true });

      const count = await db.executeForTests(
        "SELECT COUNT(*) AS n FROM watch_events WHERE steam_id = ? AND kind = 'invite'",
        [STEAM],
      );
      expect(Number(count.rows[0].n)).toBe(1);

      // ...but a repeated non-null search_id is still a duplicate.
      await db.enqueueEvent(STEAM, 'notify', 'search-dup');
      const dup = await db.enqueueEvent(STEAM, 'notify', 'search-dup');
      expect(dup.duplicate).toBe(true);
    });

    it('allows a new invite after the previous one settled', async () => {
      await db.createWatchRequest(STEAM);
      const { eventId } = await db.enqueueEvent(STEAM, 'invite');
      const [claimed] = await db.claimNextQueuedEvents('invite', 10);
      expect(claimed.id).toBe(eventId);
      expect(await db.markEventSent(claimed.id)).toBe(true);

      // Sent history does not block: a fresh invite goes through.
      const next = await db.enqueueEvent(STEAM, 'invite');
      expect(next.duplicate).toBe(false);
      expect(next.eventId).not.toBe(eventId);
    });

    it('hasOpenInviteEvent tracks the open lifecycle end to end', async () => {
      await db.createWatchRequest(STEAM);
      expect(await db.hasOpenInviteEvent(STEAM)).toBe(false);

      await db.enqueueEvent(STEAM, 'invite');
      expect(await db.hasOpenInviteEvent(STEAM)).toBe(true);

      const [claimed] = await db.claimNextQueuedEvents('invite', 10);
      // Claimed still counts as open (a worker owns it right now).
      expect(await db.hasOpenInviteEvent(STEAM)).toBe(true);

      expect(await db.markEventSent(claimed.id)).toBe(true);
      expect(await db.hasOpenInviteEvent(STEAM)).toBe(false);
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
      await confirmProfileForTests(db, '76561198000000002');
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

    it('getWatchedProfile + refreshWatchRequest round-trip on real SQL', async () => {
      expect(await db.getWatchedProfile(STEAM)).toBeNull();

      await db.createWatchRequest(STEAM, 'en');
      await expect(db.getWatchedProfile(STEAM)).resolves.toMatchObject({
        steamId: STEAM,
        status: 'pending',
        locale: 'en',
      });

      // Backdate the request, refresh, and confirm the clock moved.
      await db.executeForTests(
        "UPDATE watched_profiles SET requested_at = '2000-01-01T00:00:00.000Z' WHERE steam_id = ?",
        [STEAM],
      );
      expect(await db.refreshWatchRequest(STEAM)).toBe(true);
      const refreshed = await db.getWatchedProfile(STEAM);
      expect(refreshed).not.toBeNull();
      expect(Date.parse(refreshed!.requestedAt)).toBeGreaterThan(
        Date.parse('2020-01-01T00:00:00.000Z'),
      );

      // Active rows and missing rows do not move.
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);
      expect(await db.refreshWatchRequest(STEAM)).toBe(false);
      expect(await db.refreshWatchRequest('76561198000000009')).toBe(false);
    });

    it('refreshWatchRequest overwrites locale when valid, keeps it otherwise', async () => {
      await db.createWatchRequest(STEAM, 'en');

      expect(await db.refreshWatchRequest(STEAM, 'pt')).toBe(true);
      await expect(db.getWatchedProfile(STEAM)).resolves.toMatchObject({
        locale: 'pt',
      });

      expect(await db.refreshWatchRequest(STEAM, 'xx!!')).toBe(true);
      await expect(db.getWatchedProfile(STEAM)).resolves.toMatchObject({
        locale: 'pt',
      });

      expect(await db.refreshWatchRequest(STEAM)).toBe(true);
      await expect(db.getWatchedProfile(STEAM)).resolves.toMatchObject({
        locale: 'pt',
      });
    });

    it('recordEventAttempt counts up, requeues, then drops at the cap', async () => {
      await db.createWatchRequest(STEAM);
      const { eventId } = await db.enqueueEvent(STEAM, 'invite');
      const [claimed] = await db.claimNextQueuedEvents('invite', 10);
      expect(eventId).toBe(claimed.id);

      expect(await db.recordEventAttempt(claimed.id, 3)).toBe('requeued');
      // Requeued rows are pollable again...
      const [reclaimed] = await db.claimNextQueuedEvents('invite', 10);
      expect(reclaimed.id).toBe(claimed.id);

      expect(await db.recordEventAttempt(claimed.id, 3)).toBe('requeued');
      const [reclaimed2] = await db.claimNextQueuedEvents('invite', 10);
      expect(await db.recordEventAttempt(reclaimed2.id, 3)).toBe('dropped');

      // Settled rows are invisible to further attempts.
      expect(await db.recordEventAttempt(claimed.id, 3)).toBeNull();

      await expect(db.recordEventAttempt(claimed.id, 0)).rejects.toThrow(
        /positive/,
      );
    });
  });

  describe('WB-12 notify hook end to end (real SQL, real DAL)', () => {
    const STEAM = '76561198000000000';
    // The hook module talks to the SAME memoized client (no module reset
    // in this file), so these tests prove the full gate chain — status,
    // cooldown, idempotence — against a genuine engine, not mocks.
    const { enqueueWatchNotification } = require('./watchNotify') as {
      enqueueWatchNotification: (
        steamId: string,
        searchId: string,
        logger?: { error: (message: string) => void },
      ) => Promise<{
        enqueued: boolean;
        reason?: string;
        eventId?: number | null;
      }>;
    };
    const silentLogger = { error: jest.fn() };

    const notifyCount = async (): Promise<number> => {
      const rows = await db.executeForTests(
        "SELECT COUNT(*) AS n FROM watch_events WHERE steam_id = ? AND kind = 'notify'",
        [STEAM],
      );
      return Number(rows.rows[0].n);
    };

    it('enqueues one notify for an active watch outside cooldown', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      const result = await enqueueWatchNotification(
        STEAM,
        'hook-search-1',
        silentLogger,
      );

      expect(result.enqueued).toBe(true);
      expect(await notifyCount()).toBe(1);
      expect(silentLogger.error).not.toHaveBeenCalled();
    });

    it('collapses a repeated search_id into duplicate (single row)', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      const first = await enqueueWatchNotification(
        STEAM,
        'hook-search-dup',
        silentLogger,
      );
      const second = await enqueueWatchNotification(
        STEAM,
        'hook-search-dup',
        silentLogger,
      );

      expect(first.enqueued).toBe(true);
      expect(second).toEqual({ enqueued: false, reason: 'duplicate' });
      expect(await notifyCount()).toBe(1);
    });

    it('blocks a new search once the cooldown clock advanced (after a send)', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      await enqueueWatchNotification(STEAM, 'hook-search-sent', silentLogger);
      const [claimed] = await db.claimNextQueuedEvents('notify', 10);
      expect(await db.markEventSent(claimed.id)).toBe(true);
      expect(await db.isWithinCooldown(STEAM, 24)).toBe(true);

      const blocked = await enqueueWatchNotification(
        STEAM,
        'hook-search-after-send',
        silentLogger,
      );

      expect(blocked).toEqual({ enqueued: false, reason: 'cooldown' });
      expect(await notifyCount()).toBe(1);
    });

    it('enqueues nothing for pending or unknown watches', async () => {
      await db.createWatchRequest(STEAM);

      await expect(
        enqueueWatchNotification(STEAM, 'hook-search-pending', silentLogger),
      ).resolves.toEqual({ enqueued: false, reason: 'not-active' });
      await expect(
        enqueueWatchNotification(
          '76561198000000009',
          'hook-search-unknown',
          silentLogger,
        ),
      ).resolves.toEqual({ enqueued: false, reason: 'not-active' });
      expect(await notifyCount()).toBe(0);
    });
  });

  describe('listSentNotifications inbox read (real SQL)', () => {
    const STEAM = '76561198000000000';

    it('returns only sent notifies, newest first, honoring the limit', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      // One of each: sent, queued, dropped notify + a queued invite.
      await db.enqueueEvent(STEAM, 'notify', 'inbox-sent-1');
      await db.enqueueEvent(STEAM, 'notify', 'inbox-queued');
      await db.enqueueEvent(STEAM, 'notify', 'inbox-dropped');
      await db.enqueueEvent(STEAM, 'invite');
      const [first, , toDrop] = await db.claimNextQueuedEvents('notify', 10);
      expect(await db.markEventSent(first.id)).toBe(true);
      expect(await db.markEventDropped(toDrop.id)).toBe(true);

      // A second sent row, strictly newer (backdate the first send so the
      // ordering assertion cannot tie on millisecond timestamps).
      await db.enqueueEvent(STEAM, 'notify', 'inbox-sent-2');
      const [second] = await db.claimNextQueuedEvents('notify', 10);
      expect(await db.markEventSent(second.id)).toBe(true);
      await db.executeForTests(
        "UPDATE watch_events SET sent_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        [first.id],
      );

      const all = await db.listSentNotifications(STEAM);
      expect(all).toEqual([
        { id: second.id, sentAt: expect.any(String) },
        { id: first.id, sentAt: '2000-01-01T00:00:00.000Z' },
      ]);

      // Queued/dropped/invite rows never surface; limit truncates.
      expect(all).toHaveLength(2);
      const one = await db.listSentNotifications(STEAM, 1);
      expect(one).toEqual([{ id: second.id, sentAt: expect.any(String) }]);
    });

    it('returns [] for profiles with no delivered notifies', async () => {
      await db.createWatchRequest(STEAM);
      await expect(db.listSentNotifications(STEAM)).resolves.toEqual([]);
      await expect(
        db.listSentNotifications('76561198000000009'),
      ).resolves.toEqual([]);
    });

    it('list and count agree on hand-corrupted sent rows (NULL sent_at)', async () => {
      // A status='sent' row with NULL sent_at (hand edit — the write path
      // always stamps it) must be invisible to BOTH inbox queries, or the
      // "never disagree" guarantee between list and count breaks.
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      await db.enqueueEvent(STEAM, 'notify', 'inbox-corrupt');
      const [claimed] = await db.claimNextQueuedEvents('notify', 10);
      expect(await db.markEventSent(claimed.id)).toBe(true);
      await db.executeForTests(
        'UPDATE watch_events SET sent_at = NULL WHERE id = ?',
        [claimed.id],
      );

      await expect(db.listSentNotifications(STEAM)).resolves.toEqual([]);
      await expect(
        db.countNotificationsSince(STEAM, null),
      ).resolves.toBe(0);
      await expect(
        db.countNotificationsSince(STEAM, '2000-01-01T00:00:00.000Z'),
      ).resolves.toBe(0);
    });

    it('counts delivered rows past a watermark (backlog beyond the window)', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      // 25 delivered notifies: the read window (limit 20) cannot see them
      // all, but the count must stay exact for the badge.
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await db.enqueueEvent(STEAM, 'notify', `ct-${i}`);
      }
      const claimed = await db.claimNextQueuedEvents('notify', 25);
      for (const event of claimed) {
        // eslint-disable-next-line no-await-in-loop
        await db.markEventSent(event.id);
      }
      // Pin distinct delivery timestamps (a back-to-back burst could share
      // a millisecond, which would tie on strict > and flake the count).
      const delivered = await db.listSentNotifications(STEAM, 25);
      for (let i = 0; i < delivered.length; i += 1) {
        const stamped = `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`;
        // eslint-disable-next-line no-await-in-loop
        await db.executeForTests(
          'UPDATE watch_events SET sent_at = ? WHERE id = ?',
          [stamped, delivered[i].id],
        );
      }
      const sentAts: string[] = [];
      const restamped = await db.listSentNotifications(STEAM, 25);
      restamped.forEach((row) => sentAts.push(row.sentAt));

      expect(await db.countNotificationsSince(STEAM, null)).toBe(25);
      expect(await db.countNotificationsSince(STEAM)).toBe(25);
      const watermark = [...sentAts].sort().reverse()[0];
      expect(await db.countNotificationsSince(STEAM, watermark)).toBe(0);

      const window = await db.listSentNotifications(STEAM, 20);
      expect(window).toHaveLength(20);
      // sentAts sorted ascending: the 5 oldest sit below the window, yet
      // the count past the 5th timestamp still sees the exact visible
      // suffix — count and window agree by construction.
      const ascending = [...sentAts].sort();
      expect(await db.countNotificationsSince(STEAM, ascending[4])).toBe(20);
    });

    it('catches a late-delivered retry past an id-newer watermark', async () => {
      // The exact P1 scenario: id=5 fails and requeues while id=6 sends
      // first and gets seen. An id-cursor (id > 6) would skip id=5 forever
      // even though it delivers LATER (fresher sent_at) — the sent_at
      // cursor catches it because delivery order, not creation order, is
      // what the badge tracks.
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      await db.enqueueEvent(STEAM, 'notify', 'retry-first');
      await db.enqueueEvent(STEAM, 'notify', 'retry-second');
      const [first, second] = await db.claimNextQueuedEvents('notify', 10);
      // Second delivers first (as if the first needed a retry round).
      // Backdate it so the later delivery is strictly greater by
      // construction (two real sends could share a millisecond).
      expect(await db.markEventSent(second.id)).toBe(true);
      await db.executeForTests(
        "UPDATE watch_events SET sent_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
        [second.id],
      );
      const seen = '2026-01-01T00:00:00.000Z';

      // User opens the inbox now: watermark = second delivery.
      expect(await db.countNotificationsSince(STEAM, seen)).toBe(0);

      // The retry finally delivers — strictly later, strictly greater
      // sent_at, SMALLER id. The badge must show 1, not 0.
      expect(await db.markEventSent(first.id)).toBe(true);
      expect(await db.countNotificationsSince(STEAM, seen)).toBe(1);
      expect(first.id).toBeLessThan(second.id);
    });
  });

  describe('watch accounts + confirmation tokens against real libSQL', () => {
    const STEAM = '76561198000000001';
    const hashFor = (token: string) => db.hashConfirmToken(token);
    const future = '2999-01-01T00:00:00.000Z';
    const past = '2000-01-01T00:00:00.000Z';

    it('createAccount inserts unconfirmed and getAccount round-trips it', async () => {
      expect(await db.getAccount(STEAM)).toBeNull();

      const created = await db.createAccount(STEAM, 'pt');
      expect(created).toMatchObject({
        steamId: STEAM,
        confirmedAt: null,
        confirmTokenHash: null,
        locale: 'pt',
      });

      await expect(db.getAccount(STEAM)).resolves.toMatchObject({
        steamId: STEAM,
        confirmedAt: null,
      });
    });

    it('re-signup never resets confirmation state', async () => {
      await db.createAccount(STEAM, 'en');
      await db.issueConfirmToken(STEAM, hashFor('t1'), future);
      expect(await db.consumeConfirmToken(hashFor('t1'))).toBe(STEAM);

      const again = await db.createAccount(STEAM, 'pt');
      expect(again.confirmedAt).not.toBeNull();
    });

    it('issue arms a token; consume flips exactly once (double-click safe)', async () => {
      await db.createAccount(STEAM);
      expect(await db.issueConfirmToken(STEAM, hashFor('t2'), future)).toBe(true);

      const profile = await db.getAccount(STEAM);
      expect(profile?.confirmTokenHash).toBe(hashFor('t2'));

      // Concurrent double-click: exactly one winner, no error, no double
      // confirmation — the single UPDATE...RETURNING decides atomically.
      const [first, second] = await Promise.all([
        db.consumeConfirmToken(hashFor('t2')),
        db.consumeConfirmToken(hashFor('t2')),
      ]);
      const winners = [first, second].filter((v) => v !== null);
      expect(winners).toEqual([STEAM]);

      // Consumed means consumed: replay finds nothing.
      await expect(db.consumeConfirmToken(hashFor('t2'))).resolves.toBeNull();
      const settled = await db.getAccount(STEAM);
      expect(settled?.confirmedAt).not.toBeNull();
      expect(settled?.confirmTokenHash).toBeNull();
    });

    it('rejects expired tokens, unknown hashes, and missing rows', async () => {
      await db.createAccount(STEAM);
      await db.issueConfirmToken(STEAM, hashFor('old'), past);

      await expect(db.consumeConfirmToken(hashFor('old'))).resolves.toBeNull();
      await expect(db.consumeConfirmToken(hashFor('never'))).resolves.toBeNull();
      expect(await db.issueConfirmToken('76561198000000009', hashFor('x'), future)).toBe(
        false,
      );
      await expect(db.consumeConfirmToken('not-hex')).rejects.toThrow(
        /confirm token hash/,
      );
    });

    it('opt-out deletes watch AND account rows in one call (no record survives)', async () => {
      await db.createAccount(STEAM, 'pt');
      await db.createWatchRequest(STEAM, 'pt');
      await db.issueConfirmToken(STEAM, hashFor('gone'), future);

      await expect(
        db.removeWatchAndAccount(STEAM),
      ).resolves.toEqual({ accountDeleted: true, watchDeleted: true });

      await expect(db.getAccount(STEAM)).resolves.toBeNull();
      await expect(db.getWatchStatus(STEAM)).resolves.toBeNull();

      // And the next signup starts over unconfirmed (fresh consent).
      const again = await db.createAccount(STEAM, 'pt');
      expect(again.confirmedAt).toBeNull();
      expect(again.confirmTokenHash).toBeNull();
    });

    it('re-issue overwrites the pending token (old links die)', async () => {
      await db.createAccount(STEAM);
      await db.issueConfirmToken(STEAM, hashFor('v1'), future);
      await db.issueConfirmToken(STEAM, hashFor('v2'), future);

      await expect(db.consumeConfirmToken(hashFor('v1'))).resolves.toBeNull();
      await expect(db.consumeConfirmToken(hashFor('v2'))).resolves.toBe(STEAM);
    });

    it('refuses a second account sharing one token hash (006 unique index)', async () => {
      // Defense in depth against a broken RNG issuing the same token
      // twice: two accounts must never match one consume.
      await db.createAccount(STEAM);
      await db.createAccount('76561198000000009');
      await db.issueConfirmToken(STEAM, hashFor('shared'), future);

      await expect(
        db.executeForTests(
          `UPDATE accounts SET confirm_token_hash = ?, confirm_expires_at = ?
           WHERE steam_id = ?`,
          [hashFor('shared'), future, '76561198000000009'],
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/i);
    });

    it('lets many accounts sit tokenless (NULLs never collide)', async () => {
      await db.createAccount(STEAM);
      await db.createAccount('76561198000000009');

      await expect(db.getAccount(STEAM)).resolves.toMatchObject({
        confirmTokenHash: null,
      });
      await expect(db.getAccount('76561198000000009')).resolves.toMatchObject(
        { confirmTokenHash: null },
      );
    });

    describe('click-to-activate gate + expiry notice (real SQL)', () => {
      it('activateWatch refuses unconfirmed pending watches, flips confirmed ones', async () => {
        await db.createAccount(STEAM);
        await db.createWatchRequest(STEAM);

        // The reported bug: friendship alone (pending row, no click)
        // must never activate.
        await expect(db.activateWatch(STEAM)).resolves.toBe(false);
        expect(await db.getWatchStatus(STEAM)).toBe('pending');

        // The click (consume) opens the gate.
        await db.issueConfirmToken(STEAM, hashFor('gate-1'), future);
        expect(await db.consumeConfirmToken(hashFor('gate-1'))).toBe(STEAM);
        await expect(db.activateWatch(STEAM)).resolves.toBe(true);
        expect(await db.getWatchStatus(STEAM)).toBe('active');
      });

      it('activateWatch still flips legacy pending rows with no accounts row', async () => {
        // Pre-confirmation-epic rows consented under friendship-activates;
        // gating them would silently kill working watches.
        await db.createWatchRequest('76561198000000009');
        await expect(db.activateWatch('76561198000000009')).resolves.toBe(
          true,
        );
      });

      it('expiry scan lists only expired-unnoticed pending confirms', async () => {
        // A: expired, unconfirmed, pending -> listed.
        await db.createAccount(STEAM, 'pt');
        await db.createWatchRequest(STEAM, 'pt');
        await db.issueConfirmToken(STEAM, hashFor('exp-a'), past);
        // B: live token -> not listed.
        await db.createAccount('76561198000000002', 'en');
        await db.createWatchRequest('76561198000000002', 'en');
        await db.issueConfirmToken(
          '76561198000000002',
          hashFor('exp-b'),
          future,
        );
        // C: confirmed (consumed) -> not listed.
        await db.createAccount('76561198000000003');
        await db.createWatchRequest('76561198000000003');
        await db.issueConfirmToken(
          '76561198000000003',
          hashFor('exp-c'),
          future,
        );
        expect(await db.consumeConfirmToken(hashFor('exp-c'))).toBe(
          '76561198000000003',
        );

        const found = await db.listExpiredUnnoticedConfirms();
        expect(found).toEqual([
          {
            steamId: STEAM,
            watchLocale: 'pt',
            accountLocale: 'pt',
            expiresAt: past,
          },
        ]);
      });

      it('markExpireNoticed is conditional: a concurrent click wins', async () => {
        await db.createAccount(STEAM);
        await db.createWatchRequest(STEAM);
        await db.issueConfirmToken(STEAM, hashFor('exp-m'), past);

        // Still unconfirmed: marking succeeds and the scan goes quiet.
        expect(await db.markExpireNoticed(STEAM, past)).toBe(true);
        await expect(db.listExpiredUnnoticedConfirms()).resolves.toEqual([]);

        // A click landing first clears the token: the mark misses and the
        // poller must stand down (the user DID click — never nag them).
        await db.issueConfirmToken(STEAM, hashFor('exp-m2'), future);
        expect(await db.consumeConfirmToken(hashFor('exp-m2'))).toBe(STEAM);
        // Stale mark for the old generation: predicate misses (token gone).
        expect(await db.markExpireNoticed(STEAM, past)).toBe(false);
      });

      it('getAccountByConfirmTokenHash finds live tokens without spending them', async () => {
        await db.createAccount(STEAM, 'pt');
        await db.issueConfirmToken(STEAM, hashFor('lookup-1'), future);

        await expect(
          db.getAccountByConfirmTokenHash(hashFor('lookup-1')),
        ).resolves.toMatchObject({ steamId: STEAM, locale: 'pt' });

        // Non-consuming: the token still consumes exactly once afterwards,
        // and is unfindable once spent.
        expect(await db.consumeConfirmToken(hashFor('lookup-1'))).toBe(STEAM);
        await expect(
          db.getAccountByConfirmTokenHash(hashFor('lookup-1')),
        ).resolves.toBeNull();
      });

      it('re-issue after a notice re-arms the scan (no clearing write needed)', async () => {
        await db.createAccount(STEAM);
        await db.createWatchRequest(STEAM);
        await db.issueConfirmToken(STEAM, hashFor('exp-r1'), past);
        expect(await db.markExpireNoticed(STEAM, past)).toBe(true);
        await expect(db.listExpiredUnnoticedConfirms()).resolves.toEqual([]);

        // New generation, new expiry: noticed_for holds the OLD value, so
        // the scan picks it up again with zero extra writes.
        await db.issueConfirmToken(
          STEAM,
          hashFor('exp-r2'),
          '2001-01-01T00:00:00.000Z',
        );
        const found = await db.listExpiredUnnoticedConfirms();
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          steamId: STEAM,
          expiresAt: '2001-01-01T00:00:00.000Z',
        });
      });
    });
  });
});

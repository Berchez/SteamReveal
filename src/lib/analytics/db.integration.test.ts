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

const INBOX_INDEX_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '009_inbox_search_indexes.sql'),
  'utf8',
);

const ACCOUNTS_LAST_LOGIN_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '010_accounts_last_login.sql'),
  'utf8',
);

const BOT_HEARTBEAT_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '011_bot_heartbeat.sql'),
  'utf8',
);

const FRIENDS_VISIBILITY_MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '014_search_meta_friends_visibility.sql'),
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
  countSearchesSince: typeof import('./db').countSearchesSince;
  countSearchesInMonth: typeof import('./db').countSearchesInMonth;
  listProfileSearches: typeof import('./db').listProfileSearches;
  isWithinCooldown: typeof import('./db').isWithinCooldown;
  recordLogin: typeof import('./db').recordLogin;
  ensureActiveWatch: typeof import('./db').ensureActiveWatch;
  hashConfirmToken: typeof import('./db').hashConfirmToken;
  createAccount: typeof import('./db').createAccount;
  getAccount: typeof import('./db').getAccount;
  issueConfirmToken: typeof import('./db').issueConfirmToken;
  consumeConfirmToken: typeof import('./db').consumeConfirmToken;
  getAccountByConfirmTokenHash: typeof import('./db').getAccountByConfirmTokenHash;
  listExpiredUnnoticedConfirms: typeof import('./db').listExpiredUnnoticedConfirms;
  markExpireNoticed: typeof import('./db').markExpireNoticed;
  recordBotHeartbeat: typeof import('./db').recordBotHeartbeat;
  getBotHeartbeat: typeof import('./db').getBotHeartbeat;
  clearConfirmToken: typeof import('./db').clearConfirmToken;
  issueConfirmTokenIfAbsent: typeof import('./db').issueConfirmTokenIfAbsent;
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
    // 009 carries the inbox read-path index (profiles.steam_id) the
    // list/count inbox queries filter on.
    for (const statement of splitSqlStatements(INBOX_INDEX_MIGRATION_SQL)) {
      await db.executeForTests(statement);
    }
    // 010 carries accounts.last_login_at (login-registry audit column).
    for (const statement of splitSqlStatements(
      ACCOUNTS_LAST_LOGIN_MIGRATION_SQL,
    )) {
      await db.executeForTests(statement);
    }
    // 011 carries bot_heartbeat (bot-liveness bridge for the site gate).
    for (const statement of splitSqlStatements(BOT_HEARTBEAT_MIGRATION_SQL)) {
      await db.executeForTests(statement);
    }
    // 014 carries search_meta.friends_visibility (private-list flag).
    for (const statement of splitSqlStatements(
      FRIENDS_VISIBILITY_MIGRATION_SQL,
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
    await db.executeForTests('DELETE FROM bot_heartbeat');
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
    // Legacy input without the flag reads back NULL ("unknown").
    expect(read.friendsVisibility).toBeNull();
  });

  it('recordSearch → getSearchRecords round-trips friendsVisibility', async () => {
    await db.recordSearch({
      profile: { steamId: '76561198000000010' },
      friends: [],
      friendsVisibility: 'private',
    });
    await db.recordSearch({
      profile: { steamId: '76561198000000011' },
      friends: [],
      friendsVisibility: 'bogus' as unknown as 'private',
    });

    const records = await db.getSearchRecords();
    const bySteamId = new Map(records.map((r) => [r.profile.steamId, r]));
    expect(bySteamId.get('76561198000000010')?.friendsVisibility).toBe(
      'private',
    );
    // Unknown values degrade to NULL, never to a mislabeled bucket.
    expect(bySteamId.get('76561198000000011')?.friendsVisibility).toBeNull();
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

  describe('listProfileSearches inbox read (real SQL)', () => {
    const STEAM = '76561198000000000';

    const insertSearch = async (id: string, steamId: string, at: string) => {
      await db.executeForTests(
        'INSERT INTO searches (id, searched_at) VALUES (?, ?)',
        [id, at],
      );
      await db.executeForTests(
        'INSERT INTO profiles (search_id, steam_id) VALUES (?, ?)',
        [id, steamId],
      );
    };

    it('009 migration created the profiles(steam_id) inbox index', async () => {
      const found = await db.executeForTests(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_profiles_steam_id'",
      );
      expect(found.rows).toHaveLength(1);
    });

    it('returns every recorded search, newest first, honoring the limit', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      // Two recorded searches for the watched profile — no notify events
      // at all: the inbox must list them anyway (no cooldown gate here).
      await insertSearch('inbox-search-1', STEAM, '2000-01-01T00:00:00.000Z');
      await insertSearch('inbox-search-2', STEAM, '2026-06-02T00:00:00.000Z');

      const all = await db.listProfileSearches(STEAM);
      expect(all).toEqual([
        {
          searchId: 'inbox-search-2',
          searchedAt: '2026-06-02T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: null,
        },
        {
          searchId: 'inbox-search-1',
          searchedAt: '2000-01-01T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: null,
        },
      ]);

      // Limit truncates.
      const one = await db.listProfileSearches(STEAM, 1);
      expect(one).toEqual([
        {
          searchId: 'inbox-search-2',
          searchedAt: '2026-06-02T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: null,
        },
      ]);
    });

    it('lists cooldown-suppressed views anyway: late search still lists', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      // First search delivered by the bot; the second lands inside the
      // bot's 24h cooldown (suppressed from chat) — yet the inbox lists
      // BOTH. This is the whole point of the split.
      await insertSearch(
        'inbox-delivered',
        STEAM,
        '2026-06-01T00:00:00.000Z',
      );
      await insertSearch(
        'inbox-suppressed',
        STEAM,
        '2026-06-01T12:00:00.000Z',
      );
      await db.enqueueEvent(STEAM, 'notify', 'inbox-delivered');
      const [claimed] = await db.claimNextQueuedEvents('notify', 10);
      expect(await db.markEventSent(claimed.id)).toBe(true);
      // Pin the profile clock as if the hook had just delivered: the bot
      // would suppress the second view from chat (24h), yet the inbox
      // lists it anyway. This is the whole point of the split. Relative
      // clock (not a pinned date): a fixed 2026 stamp would age out of
      // the window and flip this test red on its own.
      await db.executeForTests(
        'UPDATE watched_profiles SET last_notified_at = ? WHERE steam_id = ?',
        [new Date(Date.now() - 3600000).toISOString(), STEAM],
      );
      await expect(db.isWithinCooldown(STEAM, 24)).resolves.toBe(true);

      const all = await db.listProfileSearches(STEAM);
      expect(all.map((row) => row.searchId)).toEqual([
        'inbox-suppressed',
        'inbox-delivered',
      ]);
    });

    it('joins the cheater flag (real tables)', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      // Real recorded search for the watched profile, cheater report opened.
      await insertSearch('inbox-real-search', STEAM, '2026-06-03T12:00:00.000Z');
      await db.executeForTests(
        'INSERT INTO cheater_results (search_id, score, computed_at) VALUES (?, ?, ?)',
        ['inbox-real-search', 0.42, '2026-06-03T12:01:00.000Z'],
      );

      const all = await db.listProfileSearches(STEAM);
      expect(all).toEqual([
        {
          searchId: 'inbox-real-search',
          searchedAt: '2026-06-03T12:00:00.000Z',
          cheaterChecked: true,
          requesterCountry: null,
        },
      ]);
    });

    it('plumbs the searcher country from search_meta (null without it)', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      await insertSearch('inbox-br', STEAM, '2026-06-04T00:00:00.000Z');
      await insertSearch('inbox-nometa', STEAM, '2026-06-05T00:00:00.000Z');
      await insertSearch('inbox-junk', STEAM, '2026-06-03T00:00:00.000Z');
      await db.executeForTests(
        'INSERT INTO search_meta (search_id, requester_locale, requester_country, requester_browser_language, device) VALUES (?, NULL, ?, NULL, NULL)',
        ['inbox-br', 'br'],
      );
      await db.executeForTests(
        'INSERT INTO search_meta (search_id, requester_locale, requester_country, requester_browser_language, device) VALUES (?, NULL, ?, NULL, NULL)',
        ['inbox-junk', 'XXL'],
      );

      const all = await db.listProfileSearches(STEAM);
      expect(all).toEqual([
        {
          searchId: 'inbox-nometa',
          searchedAt: '2026-06-05T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: null,
        },
        {
          searchId: 'inbox-br',
          searchedAt: '2026-06-04T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: 'BR',
        },
        {
          searchId: 'inbox-junk',
          searchedAt: '2026-06-03T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: null,
        },
      ]);
    });

    it('excludes pre-watch searches: stranger lookups from before the opt-in never list', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);
      // Pin the watch lifecycle: requested June 1, activated June 2.
      await db.executeForTests(
        'UPDATE watched_profiles SET requested_at = ?, activated_at = ? WHERE steam_id = ?',
        ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', STEAM],
      );

      // A stranger looked this profile up in May — before the watch
      // existed. Two more lookups landed after activation.
      await insertSearch('pre-watch-stranger', STEAM, '2026-05-15T00:00:00.000Z');
      await insertSearch('post-watch-1', STEAM, '2026-06-03T00:00:00.000Z');
      await insertSearch('post-watch-2', STEAM, '2026-06-04T00:00:00.000Z');

      const watched = await db.getWatchedProfile(STEAM);
      const floor = watched?.activatedAt ?? watched?.requestedAt ?? null;
      expect(floor).toBe('2026-06-02T00:00:00.000Z');

      const all = await db.listProfileSearches(STEAM, 25, floor);
      expect(all.map((row) => row.searchId)).toEqual([
        'post-watch-2',
        'post-watch-1',
      ]);
      await expect(db.countSearchesSince(STEAM, null, floor)).resolves.toBe(2);
      await expect(
        db.countSearchesInMonth(STEAM, Date.UTC(2026, 5, 20), floor),
      ).resolves.toBe(2);
    });

    it('countSearchesInMonth counts profile searches in the UTC month', async () => {
      // Two June searches for STEAM, one May search (outside the window),
      // one June search for another profile (another owner).
      await insertSearch('m-june-1', STEAM, '2026-06-03T12:00:00.000Z');
      await insertSearch('m-june-2', STEAM, '2026-06-20T12:00:00.000Z');
      await insertSearch('m-may', STEAM, '2026-05-31T23:59:59.000Z');
      await insertSearch(
        'm-other',
        '76561198000000009',
        '2026-06-10T12:00:00.000Z',
      );

      // Pinned mid-June: the May row and the other profile stay out.
      await expect(
        db.countSearchesInMonth(STEAM, Date.UTC(2026, 5, 15)),
      ).resolves.toBe(2);
    });

    it('returns [] for profiles with no recorded searches', async () => {
      await db.createWatchRequest(STEAM);
      await expect(db.listProfileSearches(STEAM)).resolves.toEqual([]);
      await expect(
        db.listProfileSearches('76561198000000009'),
      ).resolves.toEqual([]);
    });

    it('counts searches past a watermark (backlog beyond the window)', async () => {
      await db.createWatchRequest(STEAM);
      await confirmProfileForTests(db, STEAM);
      await db.activateWatch(STEAM);

      // 25 recorded searches: the read window (limit 20) cannot see them
      // all, but the count must stay exact for the badge. One insert per
      // second — no shared-millisecond ties on strict >.
      for (let i = 0; i < 25; i += 1) {
        const stamped = `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`;
        // eslint-disable-next-line no-await-in-loop
        await insertSearch(`ct-${i}`, STEAM, stamped);
      }
      const searchedAts: string[] = [];
      const listed = await db.listProfileSearches(STEAM, 25);
      listed.forEach((row) => searchedAts.push(row.searchedAt));

      expect(await db.countSearchesSince(STEAM, null)).toBe(25);
      expect(await db.countSearchesSince(STEAM)).toBe(25);
      const watermark = [...searchedAts].sort().reverse()[0];
      expect(await db.countSearchesSince(STEAM, watermark)).toBe(0);

      const window = await db.listProfileSearches(STEAM, 20);
      expect(window).toHaveLength(20);
      // searchedAts sorted ascending: the 5 oldest sit below the window,
      // yet the count past the 5th timestamp still sees the exact visible
      // suffix — count and window agree by construction.
      const ascending = [...searchedAts].sort();
      expect(await db.countSearchesSince(STEAM, ascending[4])).toBe(20);
    });
  });

  describe('watch accounts + confirmation tokens against real libSQL', () => {
    const STEAM = '76561198000000001';
    const hashFor = (token: string) => db.hashConfirmToken(token);
    const future = '2999-01-01T00:00:00.000Z';
    const past = '2000-01-01T00:00:00.000Z';

    describe('recordLogin (single-state login registry, real SQL)', () => {
      const OTHER = '76561198000000002';

      it('inserts on first login (created_at pinned) and refreshes last_login_at on re-login', async () => {
        const first = await db.recordLogin(STEAM, 'pt');
        expect(first).toMatchObject({ steamId: STEAM, locale: 'pt' });
        expect(first.createdAt).toBe(first.lastLoginAt);
        // created_at is pinned, never reset.
        const firstCreatedAt = first.createdAt;

        const second = await db.recordLogin(STEAM, 'en');
        expect(second.createdAt).toBe(firstCreatedAt);
        expect(second.lastLoginAt).not.toBeNull();
        // A real re-login later must move the clock forward; pin by
        // injecting a distinct write would need SQL — assert ordering only.
        expect(second.locale).toBe('en');

        // The audit answer: one row, latest login visible.
        const row = await db.getAccount(STEAM);
        expect(row?.createdAt).toBe(firstCreatedAt);
        expect(row?.lastLoginAt).toBe(second.lastLoginAt);
      });

      it('keeps distinct rows per steamId (each login audited separately)', async () => {
        await db.recordLogin(STEAM, 'pt');
        const other = await db.recordLogin(OTHER, 'es');
        expect(other.steamId).toBe(OTHER);
        expect(await db.getAccount(OTHER)).toMatchObject({ steamId: OTHER });

        const rows = await db.executeForTests(
          'SELECT COUNT(*) AS n FROM accounts',
        );
        expect(Number(rows.rows[0].n)).toBe(2);
      });

      it('COALESCE keeps an existing locale when the new one is absent', async () => {
        await db.recordLogin(STEAM, 'de');
        const relogin = await db.recordLogin(STEAM, null);
        expect(relogin.locale).toBe('de');
      });

      it('validates the steamId before touching the client', async () => {
        await expect(db.recordLogin('short')).rejects.toThrow(/17 digits/);
      });
    });

    describe('ensureActiveWatch (single-state active watch, real SQL)', () => {
      it('inserts fresh profiles directly as active and reports activated', async () => {
        const { profile, activated } = await db.ensureActiveWatch(STEAM, 'pt');
        expect(profile).toMatchObject({
          steamId: STEAM,
          status: 'active',
          locale: 'pt',
          activatedAt: profile.requestedAt,
        });
        expect(activated).toBe(true);
        await expect(db.getWatchStatus(STEAM)).resolves.toBe('active');
      });

      it('re-login on an active row is idempotent (activated=false, no flip)', async () => {
        await db.ensureActiveWatch(STEAM, 'pt');
        const second = await db.ensureActiveWatch(STEAM, 'en');
        expect(second.activated).toBe(false);
        expect(second.profile.status).toBe('active');
        // Locale refresh still applies on re-login.
        expect(second.profile.locale).toBe('en');
      });

      it('flips legacy pending rows to active (grandfathered consent + proven friendship)', async () => {
        await db.createWatchRequest(STEAM, 'es');
        expect(await db.getWatchStatus(STEAM)).toBe('pending');

        const { activated, profile } = await db.ensureActiveWatch(STEAM, 'pt');
        expect(activated).toBe(true);
        expect(profile.status).toBe('active');
        expect(await db.getWatchStatus(STEAM)).toBe('active');
      });

      it('leaves pending rows with an UNCONFIRMED account (link click owns them)', async () => {
        await db.createWatchRequest(STEAM, 'es');
        await db.createAccount(STEAM, 'es');
        expect(await db.getWatchStatus(STEAM)).toBe('pending');

        const { activated, profile } = await db.ensureActiveWatch(STEAM, 'pt');
        expect(activated).toBe(false);
        expect(profile.status).toBe('pending');
        expect(await db.getWatchStatus(STEAM)).toBe('pending');
      });

      it('flips pending rows once the account confirms (click happened first)', async () => {
        await db.createWatchRequest(STEAM, 'es');
        await db.createAccount(STEAM, 'es');
        const token = 'cd'.repeat(32);
        expect(
          await db.issueConfirmToken(
            STEAM,
            db.hashConfirmToken(token),
            new Date(Date.now() + 3600000).toISOString(),
          ),
        ).toBe(true);
        expect(await db.consumeConfirmToken(db.hashConfirmToken(token))).toBe(
          STEAM,
        );

        const { activated, profile } = await db.ensureActiveWatch(STEAM, 'pt');
        expect(activated).toBe(true);
        expect(profile.status).toBe('active');
        expect(await db.getWatchStatus(STEAM)).toBe('active');
      });

      it('concurrent first-calls converge on ONE activated=true and one active row', async () => {
        const results = await Promise.all([
          db.ensureActiveWatch(STEAM, 'pt'),
          db.ensureActiveWatch(STEAM, 'pt'),
        ]);
        const activations = results.filter((r) => r.activated).length;
        expect(activations).toBe(1);
        const rows = await db.executeForTests(
          'SELECT COUNT(*) AS n FROM watched_profiles WHERE steam_id = ?',
          [STEAM],
        );
        expect(Number(rows.rows[0].n)).toBe(1);
      });

      it('validates the steamId before touching the client', async () => {
        await expect(db.ensureActiveWatch('short')).rejects.toThrow(
          /17 digits/,
        );
      });
    });

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

      it('activation gate equivalence: ensureActiveWatch and activateWatch agree on every account state', async () => {
        // The click-to-activate predicate lives in TWO hand-written
        // shapes (activateWatch's atomic UPDATE subqueries vs
        // ensureActiveWatch's read-then-flip) held apart on purpose —
        // extraction would cost activateWatch its single-statement
        // atomicity. This test is the shared tripwire instead: one matrix,
        // both gates, so a drift in either fails HERE (login re-opening
        // the confirmation bypass must never reach production).
        const setup = {
          legacy: (id: string) => db.createWatchRequest(id, 'pt'),
          unconfirmed: async (id: string) => {
            await db.createAccount(id, 'pt');
            await db.createWatchRequest(id, 'pt');
          },
          confirmed: (id: string) => confirmProfileForTests(db, id),
        };

        // Disjoint ids per (case, gate) — identical setup on both sides.
        const ids: Record<
          'legacy' | 'unconfirmed' | 'confirmed',
          { activateWatch: string; ensureActiveWatch: string }
        > = {
          legacy: {
            activateWatch: '76561198000000021',
            ensureActiveWatch: '76561198000000022',
          },
          unconfirmed: {
            activateWatch: '76561198000000023',
            ensureActiveWatch: '76561198000000024',
          },
          confirmed: {
            activateWatch: '76561198000000025',
            ensureActiveWatch: '76561198000000026',
          },
        };

        const checkBothGates = async (
          state: 'legacy' | 'unconfirmed' | 'confirmed',
          expected: boolean,
        ): Promise<void> => {
          const pair = ids[state];
          await setup[state](pair.activateWatch);
          await setup[state](pair.ensureActiveWatch);

          const byUpdate = await db.activateWatch(pair.activateWatch);
          const byLogin = await db.ensureActiveWatch(
            pair.ensureActiveWatch,
            'pt',
          );

          expect(byUpdate).toBe(expected);
          expect(byLogin.activated).toBe(expected);
          // Both gates converge on the SAME watch status, always.
          expect(await db.getWatchStatus(pair.activateWatch)).toBe(
            expected ? 'active' : 'pending',
          );
          expect(await db.getWatchStatus(pair.ensureActiveWatch)).toBe(
            expected ? 'active' : 'pending',
          );
        };

        await checkBothGates('legacy', true);
        await checkBothGates('unconfirmed', false);
        await checkBothGates('confirmed', true);
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

  describe('clearConfirmToken (undelivered-token rollback, real SQL)', () => {
    const STEAM = '76561198000000001';
    const hashFor = (token: string) => db.hashConfirmToken(token);
    const future = '2999-01-01T00:00:00.000Z';

    it('clears exactly the issued hash and returns the account to never-issued', async () => {
      await db.createAccount(STEAM, 'pt');
      await db.issueConfirmToken(STEAM, hashFor('rb-1'), future);
      expect((await db.getAccount(STEAM))?.confirmTokenHash).toBe(
        hashFor('rb-1'),
      );

      // Wrong hash (a newer generation replaced the token mid-flight):
      // compare-and-delete refuses — state stands.
      expect(await db.clearConfirmToken(STEAM, hashFor('rb-other'))).toBe(
        false,
      );
      expect((await db.getAccount(STEAM))?.confirmTokenHash).toBe(
        hashFor('rb-1'),
      );

      // Exact hash: hash + expiry both go, confirmation untouched.
      expect(await db.clearConfirmToken(STEAM, hashFor('rb-1'))).toBe(true);
      const after = await db.getAccount(STEAM);
      expect(after?.confirmTokenHash).toBeNull();
      expect(after?.confirmExpiresAt).toBeNull();
      expect(after?.confirmedAt).toBeNull();

      // Back to never-issued: a fresh generation arms again (this is
      // what lets the next reconcile pass retry the delivery).
      expect(await db.issueConfirmToken(STEAM, hashFor('rb-2'), future)).toBe(
        true,
      );
    });

    it('never rolls back a consumed token (a concurrent click wins)', async () => {
      await db.createAccount(STEAM);
      await db.issueConfirmToken(STEAM, hashFor('rb-click'), future);
      expect(await db.consumeConfirmToken(hashFor('rb-click'))).toBe(STEAM);

      // The click cleared the hash and set confirmed_at — a late rollback
      // must be a no-op, never a confirmation eraser.
      expect(await db.clearConfirmToken(STEAM, hashFor('rb-click'))).toBe(
        false,
      );
      const account = await db.getAccount(STEAM);
      expect(account?.confirmedAt).not.toBeNull();
      expect(account?.confirmTokenHash).toBeNull();
    });

    it('returns false for an account that never issued (idempotent no-op)', async () => {
      await db.createAccount(STEAM);
      expect(await db.clearConfirmToken(STEAM, hashFor('rb-none'))).toBe(
        false,
      );
    });
  });

  describe('issueConfirmTokenIfAbsent (first-contact guard, real SQL)', () => {
    const STEAM = '76561198000000001';
    const hashFor = (token: string) => db.hashConfirmToken(token);
    const future = '2999-01-01T00:00:00.000Z';

    it('arms when no generation is outstanding, refuses when one is (no overwrite)', async () => {
      await db.createAccount(STEAM, 'pt');

      expect(await db.issueConfirmTokenIfAbsent(STEAM, hashFor('g-1'), future)).toBe(
        true,
      );
      expect((await db.getAccount(STEAM))?.confirmTokenHash).toBe(
        hashFor('g-1'),
      );

      // A live generation outstanding: the guarded issue loses instead of
      // overwriting (this is what lets a concurrent resend-lane issue win
      // deterministically instead of double-delivering).
      expect(await db.issueConfirmTokenIfAbsent(STEAM, hashFor('g-2'), future)).toBe(
        false,
      );
      expect((await db.getAccount(STEAM))?.confirmTokenHash).toBe(
        hashFor('g-1'),
      );
    });

    it('refuses on confirmed accounts and re-arms after a rollback', async () => {
      await db.createAccount(STEAM);
      await db.issueConfirmToken(STEAM, hashFor('g-c'), future);
      expect(await db.consumeConfirmToken(hashFor('g-c'))).toBe(STEAM);

      expect(await db.issueConfirmTokenIfAbsent(STEAM, hashFor('g-d'), future)).toBe(
        false,
      );

      // Post-rollback state (hash cleared): the next reconcile pass
      // re-arms normally — the recovery loop the rollback exists for.
      await db.createAccount('76561198000000002');
      await db.issueConfirmToken('76561198000000002', hashFor('g-e'), future);
      expect(await db.clearConfirmToken('76561198000000002', hashFor('g-e'))).toBe(
        true,
      );
      expect(
        await db.issueConfirmTokenIfAbsent(
          '76561198000000002',
          hashFor('g-f'),
          future,
        ),
      ).toBe(true);
    });
  });

  describe('bot heartbeat (bot-liveness bridge)', () => {
    const BOT_STEAM = '76561199000000001';

    it('round-trips the upsert: write, read, overwrite — still one row', async () => {
      await db.recordBotHeartbeat(true, BOT_STEAM);
      await expect(db.getBotHeartbeat()).resolves.toEqual({
        beatAt: expect.any(String),
        connected: true,
        steamId: BOT_STEAM,
        disconnectedSince: null,
      });

      // A later beat overwrites in place (single row, never grows).
      await db.recordBotHeartbeat(false, null);
      await expect(db.getBotHeartbeat()).resolves.toEqual({
        beatAt: expect.any(String),
        connected: false,
        steamId: null,
        disconnectedSince: expect.any(String),
      });
      const rows = await db.executeForTests(
        'SELECT COUNT(*) AS n FROM bot_heartbeat',
      );
      expect(Number(rows.rows[0].n)).toBe(1);
    });

    it('maintains disconnected_since atomically: earliest survives, reconnect clears', async () => {
      // First disconnected beat opens the window at its own beat time.
      await db.recordBotHeartbeat(false, null);
      const first = await db.getBotHeartbeat();
      expect(first?.disconnectedSince).toBe(first?.beatAt);
      expect(Number.isFinite(Date.parse(first?.disconnectedSince ?? ''))).toBe(
        true,
      );

      // A later disconnected beat must NOT restart the window (COALESCE
      // keeps the earliest) — this is the gate's sustained-outage clock.
      await db.recordBotHeartbeat(false, null);
      const second = await db.getBotHeartbeat();
      expect(second?.beatAt && second?.beatAt >= (first?.beatAt ?? '')).toBe(
        true,
      );
      expect(second?.disconnectedSince).toBe(first?.disconnectedSince);

      // Reconnect clears the window: the gate immediately trusts the bot
      // again (a reconnection genuinely restores login capability).
      await db.recordBotHeartbeat(true, BOT_STEAM);
      const reconnected = await db.getBotHeartbeat();
      expect(reconnected?.connected).toBe(true);
      expect(reconnected?.disconnectedSince).toBeNull();

      // A new disconnect opens a FRESH window (the old one is gone).
      await db.recordBotHeartbeat(false, null);
      const reopened = await db.getBotHeartbeat();
      expect(reopened?.disconnectedSince).toBe(reopened?.beatAt);
    });

    it('returns null before the first beat (fail-open upstream)', async () => {
      await expect(db.getBotHeartbeat()).resolves.toBeNull();
    });
  });
});

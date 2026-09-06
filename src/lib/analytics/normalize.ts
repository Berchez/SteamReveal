/**
 * Shared child-entry filters for the analytics write path.
 *
 * Both recordSearch() (live route inserts) and the migration import
 * (migrate-utils.buildStatements) insert rows into the child tables
 * (friends, games_snapshot, location_guesses). A single malformed child must
 * never fail the whole atomic batch, so both paths drop entries that would
 * violate a NOT NULL/REAL constraint or carry junk identifiers.
 *
 * These mirrors of the route-side validators in input.ts (same bounds, same
 * trim semantics) run again here as defense in depth: recordSearch can be
 * called by anything, not just the parsed route payload.
 */
import type { FriendRecord, GameSnapshotEntry, LocationGuess } from './types';

// Defensive bounds on child-table row counts. A malformed/abusive payload must
// not turn into thousands of statements inside one db.batch(). These match
// what the real frontend can legitimately send (homeAnalyticsUtils.ts):
//   - locationGuess is hard-capped at 3 by the client (.slice(0, 3)), so 10
//     leaves huge headroom while cutting the abuse surface by an order of
//     magnitude vs 100.
//   - friends/gamesSnapshot are sent unbounded; Steam caps an account at 1000
//     friends, and a games snapshot sorted by playtime can exceed 1000 for
//     large libraries — truncating below that would silently drop legit data.
// The route parser (input.ts) slices to these same caps; recordSearch applies
// them again as defense in depth so ANY caller (tests, scripts, another route)
// can't explode a batch. Items are validated individually so ONE bad
// friend/game/guess can't take down the whole (atomic) insert; the per-IP
// app-level rate limit is the remaining bound on sustained abuse.
export const MAX_FRIENDS = 1000;
export const MAX_GAMES_SNAPSHOT = 1000;
export const MAX_LOCATION_GUESSES = 10;

// Probability is a 0–100 percentage everywhere it's produced (cheater model
// and location triangulation both emit 0–100; the real archive peaks at
// ~99.99). Route-side validators (input.ts) already bound it; these mirrors
// re-apply the same bound here as defense in depth, because recordSearch and
// the migration import can be fed by anything, not just the parsed route
// payload. Friends carry it optionally (undefined/null allowed — the column
// is nullable); location guesses require it (NOT NULL).
const optionalProbability = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100);

const requiredProbability = (value: unknown): boolean =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;

export const filterValidFriends = (friends: FriendRecord[]): FriendRecord[] =>
  friends.filter(
    (f) =>
      typeof f.steamId === 'string' &&
      f.steamId.trim().length > 0 &&
      f.steamId.length <= 64 &&
      optionalProbability(f.probability),
  );

export const filterValidGames = (
  games: GameSnapshotEntry[],
): GameSnapshotEntry[] =>
  games.filter(
    (g) =>
      typeof g.name === 'string' &&
      g.name.trim().length > 0 &&
      g.name.length <= 2000 &&
      typeof g.playtimeHours === 'number' &&
      Number.isFinite(g.playtimeHours),
  );

export const filterValidLocations = (locations: LocationGuess[]): LocationGuess[] =>
  locations.filter(
    (l) =>
      requiredProbability(l.probability) &&
      typeof l.location === 'object' &&
      l.location !== null,
  );
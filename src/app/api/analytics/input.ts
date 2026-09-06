import type {
  FriendRecord,
  LocationGuess,
  GameSnapshotEntry,
  NewSearchInput,
} from '@/lib/analytics/types';
import {
  MAX_FRIENDS,
  MAX_GAMES_SNAPSHOT,
  MAX_LOCATION_GUESSES,
} from '@/lib/analytics/normalize';

/**
 * Body parsing for the analytics write routes.
 *
 * This used to live inline on the local proxy (src/proxy-local/server.ts);
 * now the Vercel routes normalize the payload themselves before pushing it
 * straight into the Turso DAL. The frontend sends exactly this shape (see
 * src/app/templates/Home/shared/analytics/homeAnalyticsUtils.ts), but the
 * parsers stay defensive: optional fields accept only their expected type
 * and fall back to null.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const nullableString = (value: unknown, maxLength = 2000): string | null =>
  typeof value === 'string' && value.length <= maxLength ? value : null;

const nullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Steam64 IDs are always exactly 17 digits (76561197960265728 + accountID,
// the max uint32 accountID still lands at 17 digits). The real frontend sends
// them straight from the Steam API; filtering to this shape means an abusive
// or malformed payload can't stuff arbitrary strings into a 0–100 confidence
// column that real users will later eyeball on the dashboard.
const STEAM64_ID_REGEX = /^\d{17}$/;

// Optional-ish friend fields must accept only their expected types so a
// wrong-typed value (e.g. mutualCount as a string) never sneaks into a REAL
// column read back as null on the dashboard. Each field accepts undefined,
// null, or its declared type, with the same length bounds as nullableString().
const isValidFriend = (value: unknown): value is FriendRecord => {
  if (!isRecord(value)) return false;
  if (typeof value.steamId !== 'string' || !STEAM64_ID_REGEX.test(value.steamId)) {
    return false;
  }

  const optionalString = (field: unknown): boolean =>
    field === undefined ||
    field === null ||
    (typeof field === 'string' && field.length <= 2000);

  const optionalFiniteNumber = (field: unknown): boolean =>
    field === undefined ||
    field === null ||
    (typeof field === 'number' && Number.isFinite(field));

  // Probability is a 0–100 percentage everywhere it's produced (cheater model
  // and location triangulation both emit 0–100; the real archive peaks at
  // ~99.99). Accept undefined/null (friends don't always carry it) but bound
  // any actual number to that scale so a malformed 400+ or negative value
  // can't be stored as if it were a believable confidence.
  const optionalProbability = (field: unknown): boolean =>
    field === undefined ||
    field === null ||
    (typeof field === 'number' &&
      Number.isFinite(field) &&
      field >= 0 &&
      field <= 100);

  return (
    optionalString(value.nickname) &&
    optionalString(value.gcName) &&
    optionalString(value.countryCode) &&
    optionalFiniteNumber(value.mutualCount) &&
    optionalProbability(value.probability)
  );
};

const isValidGame = (value: unknown): value is GameSnapshotEntry =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  value.name.length <= 2000 &&
  value.name.trim().length > 0 &&
  typeof value.playtimeHours === 'number' &&
  Number.isFinite(value.playtimeHours);

// The nested location object is stored as JSON (TEXT), so its optional fields
// must stay strings — a stray number/boolean elsewhere would still serialize,
// but every field is bounded the same way the top-level strings are.
const isValidLocationGuess = (value: unknown): value is LocationGuess => {
  if (!isRecord(value)) return false;
  // Location confidence is a 0–100 percentage (same scale as friend
  // probability; the real archive peaks around 99.99).
  if (
    typeof value.probability !== 'number' ||
    !Number.isFinite(value.probability) ||
    value.probability < 0 ||
    value.probability > 100
  ) {
    return false;
  }
  if (!isRecord(value.location)) return false;

  const cappedString = (field: unknown): boolean =>
    field === undefined ||
    (typeof field === 'string' && field.length <= 2000);

  return (
    cappedString(value.location.cityName) &&
    cappedString(value.location.stateName) &&
    cappedString(value.location.countryName) &&
    cappedString(value.location.countryCode)
  );
};

export const parseRecordBody = (body: unknown): NewSearchInput | null => {
  if (!isRecord(body)) return null;

  const { profile, friends, gamesSnapshot } = body;

  if (!isRecord(profile)) return null;
  const { steamId } = profile;
  if (typeof steamId !== 'string' || !STEAM64_ID_REGEX.test(steamId)) return null;

  const deviceValue =
    body.device === 'mobile' || body.device === 'desktop' ? body.device : null;

  return {
    profile: {
      steamId,
      steamUrl: nullableString(profile.steamUrl),
      nickname: nullableString(profile.nickname),
      gcName: nullableString(profile.gcName),
      countryCode: nullableString(profile.countryCode),
      stateCode: nullableString(profile.stateCode),
      cityId: typeof profile.cityId === 'string' || typeof profile.cityId === 'number'
        ? (profile.cityId as string | number)
        : null,
    },
    friends: Array.isArray(friends)
      ? friends.filter(isValidFriend).slice(0, MAX_FRIENDS)
      : [],
    gamesSnapshot: Array.isArray(gamesSnapshot)
      ? gamesSnapshot.filter(isValidGame).slice(0, MAX_GAMES_SNAPSHOT)
      : null,
    isCSActive: typeof body.isCSActive === 'boolean' ? body.isCSActive : null,
    requesterLocale: nullableString(body.requesterLocale),
    requesterCountry: nullableString(body.requesterCountry),
    requesterBrowserLanguage: nullableString(body.requesterBrowserLanguage),
    device: deviceValue,
    locationGuess: Array.isArray(body.locationGuess)
      ? body.locationGuess.filter(isValidLocationGuess).slice(0, MAX_LOCATION_GUESSES)
      : null,
    durationMs: nullableNumber(body.durationMs),
  };
};

export interface ParsedCheaterInput {
  searchId: string;
  score: number;
  bannedFriendsCount: number | null;
}

export const parseCheaterBody = (body: unknown): ParsedCheaterInput | null => {
  if (!isRecord(body)) return null;
  if (typeof body.searchId !== 'string' || body.searchId.length === 0) return null;
  // The score is mostly a 0–100 percentage (the dashboard normalizes legacy
  // 0–1 fractions — e.g. cheater.model output — into that scale), so bound it
  // like friend/location probability: any finite number within 0–100 is a
  // believable confidence, anything else is garbage.
  if (
    typeof body.score !== 'number' ||
    !Number.isFinite(body.score) ||
    body.score < 0 ||
    body.score > 100
  ) {
    return null;
  }

  return {
    searchId: body.searchId,
    score: body.score,
    bannedFriendsCount: nullableNumber(body.bannedFriendsCount),
  };
};
import axios from 'axios';
import { UserSummary } from 'steamapi';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import { locationDataIWant } from '@/@types/locationDataIWant';

// ---- Analytics helpers ---------------------------------------------------

// Dedicated, short budget for the best-effort CS-active enrichment. Fetching
// a user's owned games with `includeAppInfo: true` makes Steam resolve per-game
// metadata, which for large libraries is noticeably slower than a plain
// summary/resolve. This enrichment is optional (it only feeds the "don't spend
// money on non-CS profiles" cost gate) so it must never hold up the primary
// profile/card response that drives LCP/CLS. Shared by the client search route
// (/api/getUserInfo) and the SSR seed path (getPlayerProfile) so both cap the
// worst-case latency identically instead of the 8s general Steam-call timeout.
export const CS_ACTIVE_ENRICHMENT_TIMEOUT_MS = 2500;

// Moved from useHome.ts without behavioral changes. Kept as a pure module
// (not a hook) because nothing here uses React state or lifecycle — the same
// approach as the existing homeUtils.ts and probabilityMath.ts modules.

export const getRequesterDevice = (): 'mobile' | 'desktop' | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 'mobile'
    : 'desktop';
};

export const getRequesterCountry = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.body.getAttribute('data-country');
};

export const getRequesterBrowserLanguage = (): string | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return navigator.language ?? null;
};

export type GameSnapshotEntry = {
  name: string;
  playtimeHours: number;
};

/**
 * Normalizes a raw "owned games" list (either the steamapi Game[] shape with
 * nested `.game.name` / `.playtime_forever`, or a flattened shape) into the
 * `{ name, playtimeHours }` snapshot used for analytics + the CS-active flag.
 * Server-safe (no browser globals) so both /api/getUserInfo and the SSR seed
 * path (getPlayerProfile) can share it.
 */
export const getGamesSnapshot = (
  games:
    | Array<
        | {
            name?: string;
            playtime_forever?: number;
            playtimeForever?: number;
            minutes?: number;
            game?: {
              name?: string;
              playtimeForever?: number;
            };
          }
        | undefined
      >
    | undefined,
): GameSnapshotEntry[] => {
  if (!Array.isArray(games) || games.length === 0) {
    return [];
  }

  return games
    .map((game) => {
      let name = '';
      if (typeof game?.game?.name === 'string') {
        name = game.game.name;
      } else if (typeof game?.name === 'string') {
        name = game.name;
      }
      const playtimeForever = Number(
        game?.playtime_forever ?? game?.playtimeForever ?? game?.minutes ?? 0,
      );
      const playtimeHours =
        Number.isFinite(playtimeForever) && playtimeForever > 0
          ? playtimeForever / 60
          : 0;
      return {
        name,
        playtimeHours: Number(
          (Math.round(playtimeHours * 10) / 10).toFixed(1),
        ),
      };
    })
    .filter((game) => game.name)
    .sort((a, b) => b.playtimeHours - a.playtimeHours);
};

const normalizeGamePlaytimeHours = (
  game:
    | {
        name?: string;
        playtimeForever?: number;
        playtimeHours?: number;
        minutes?: number;
      }
    | undefined,
): number => {
  if (!game) {
    return 0;
  }

  let rawValue = 0;

  if (typeof game.playtimeHours === 'number') {
    rawValue = game.playtimeHours;
  } else if (typeof game.playtimeForever === 'number') {
    rawValue = game.playtimeForever / 60;
  } else if (typeof game.minutes === 'number') {
    rawValue = game.minutes / 60;
  }

  return Number.isFinite(rawValue) ? rawValue : 0;
};

export const getGameSnapshotFromTargetInfo = (
  targetInfo:
    | {
        gamesSnapshot?: GameSnapshotEntry[];
        gamesPlayed?: Array<{
          name?: string;
          playtimeForever?: number;
          playtimeHours?: number;
          minutes?: number;
        }>;
      }
    | undefined,
): GameSnapshotEntry[] => {
  let games: Array<{
    name?: string;
    playtimeForever?: number;
    playtimeHours?: number;
    minutes?: number;
  }> = [];

  if (Array.isArray(targetInfo?.gamesSnapshot) && targetInfo.gamesSnapshot.length > 0) {
    games = targetInfo.gamesSnapshot;
  } else if (Array.isArray(targetInfo?.gamesPlayed)) {
    games = targetInfo.gamesPlayed;
  }

  return games
    .filter(
      (game): game is {
        name: string;
        playtimeForever?: number;
        playtimeHours?: number;
        minutes?: number;
      } => typeof game?.name === 'string' && game.name.trim().length > 0,
    )
    .map((game) => ({
      name: game.name,
      playtimeHours: Number(
        (Math.round(normalizeGamePlaytimeHours(game) * 10) / 10).toFixed(1),
      ),
    }))
    .sort((a, b) => b.playtimeHours - a.playtimeHours);
};

export const isCounterStrikeActive = (
  gamesPlayed:
    | Array<{ name: string; playtimeForever?: number; playtimeHours?: number; minutes?: number }>
    | undefined,
): boolean => {
  if (!gamesPlayed || gamesPlayed.length === 0) {
    return false;
  }

  const CS_HOUR_THRESHOLD = 300;

  const csGame = gamesPlayed.find((g) =>
    g.name.toLowerCase().includes('counter-strike'),
  );

  if (csGame) {
    const csHours = normalizeGamePlaytimeHours(csGame);
    if (csHours >= CS_HOUR_THRESHOLD) {
      return true;
    }
  }

  const topGame = gamesPlayed[0];
  if (topGame && topGame.name.toLowerCase().includes('counter-strike')) {
    return true;
  }

  return false;
};

const ANALYTICS_SKIP_PASSWORD_KEY = 'analytics_skip_password';

export const getAnalyticsSkipHeaders = ():
  | Record<string, string>
  | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const skipPassword = localStorage.getItem(ANALYTICS_SKIP_PASSWORD_KEY);

    return skipPassword
      ? { 'x-analytics-skip-password': skipPassword }
      : undefined;
  } catch (e) {
    return undefined;
  }
};

export type AnalyticsMeta = {
  requesterLocale: string | null;
  requesterCountry: string | null;
  requesterBrowserLanguage: string | null;
  device: 'mobile' | 'desktop' | null;
  durationMs: number | null;
};

export const recordAnalytics = async (
  targetInfo: UserSummary | undefined,
  closeFriends: closeFriendsDataIWant[] | undefined,
  possibleLocation: locationDataIWant[] | undefined,
  meta: AnalyticsMeta,
): Promise<string | null> => {
  if (!targetInfo?.steamID) {
    return null;
  }

  let targetGcName: string | null = null;

  try {
    const { data } = await axios.post('/api/getGamersClubName', {
      steamId: targetInfo.steamID,
    });

    targetGcName = data.gcName;
  } catch (e) {
    // Best effort, ignore failures
  }

  try {
    const gamesSnapshot = getGameSnapshotFromTargetInfo(
      targetInfo as UserSummary & { gamesSnapshot?: GameSnapshotEntry[] },
    );
    const isCSActive = isCounterStrikeActive(gamesSnapshot);

    const payload = {
      profile: {
        steamId: targetInfo.steamID,
        steamUrl: targetInfo.url ?? null,
        nickname: targetInfo.nickname ?? null,
        gcName: targetGcName,
        countryCode: targetInfo.countryCode ?? null,
        stateCode: targetInfo.stateCode ?? null,
        cityId: targetInfo.cityID ?? null,
      },

      gamesSnapshot,
      isCSActive,

      friends: (closeFriends ?? []).map((f) => ({
        steamId: f.friend.steamID,
        nickname: f.friend.nickname ?? null,
        gcName: null,
        mutualCount: f.count ?? null,
        probability: f.probability ?? null,
        countryCode: f.friend.countryCode ?? null,
      })),

      locationGuess: (possibleLocation ?? []).slice(0, 3).map((l) => ({
        location: l.location,
        probability: l.probability,
      })),

      requesterLocale: meta.requesterLocale,
      requesterCountry: meta.requesterCountry,
      requesterBrowserLanguage: meta.requesterBrowserLanguage,
      device: meta.device,
      durationMs: meta.durationMs,
    };

    const { data } = await axios.post('/api/recordAnalytics', payload, {
      headers: getAnalyticsSkipHeaders(),
    });

    if (data?.skipped) {
      return null;
    }

    return data?.id ?? null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[Analytics] Failed to record search:', e);
    return null;
  }
};

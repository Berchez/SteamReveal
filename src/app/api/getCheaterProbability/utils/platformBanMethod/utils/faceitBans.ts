import axios from 'axios';
import classifyBanReason, {
  BanClassification,
} from './classifyBanReason';

const STEAM64_ID_REGEX = /^\d{17}$/;
/**
 * Per-call timeout for the FACEIT Open Data API. Exported so the outer
 * `platformBanMethod` wrapper can derive its own *total* budget from it (a
 * FACEIT lookup is two sequential stages → this × 2 + margin), keeping the
 * two timeouts coupled in code instead of as a magic number in another file.
 */
export const FACEIT_TIMEOUT_MS = 8000;

export type FaceitBanStatus = {
  banned: boolean;
  reason: string | null;
  playerId: string | null;
  classification: BanClassification | null;
  /**
   * Total CS2 matches played by this player on FACEIT (from the stats/cs2
   * endpoint). Best-effort: null when the player isn't found, the stats aren't
   * exposed, or the call fails/times out. Used to discount the cheater
   * probability for players who are demonstrably active on a platform with an
   * invasive anti-cheat.
   */
  matches: number | null;
};

/**
 * Shared "no data / not banned" value (single source of truth for the empty
 * fallback). Imported by `platformBanMethod/index.ts` for the timeout path so
 * the wrapper and call sites don't each hand-maintain a duplicate shape.
 */
export const faceitNotBannedStatus: FaceitBanStatus = {
  banned: false,
  reason: null,
  playerId: null,
  classification: null,
  matches: null,
};

const notBanned = (playerId: string | null): FaceitBanStatus => ({
  ...faceitNotBannedStatus,
  playerId,
});

/**
 * Stats endpoints we consult for the "activity" match count. A FACEIT account
 * usually holds both a CS2 and a CS:GO profile (the same player_id, separate
 * per-game stats), so we sum the two — the profile's total match count is the
 * sum across every game/mode.
 */
const ACTIVITY_GAMES = ['cs2', 'csgo'] as const;

/**
 * Sums the per-mode/per-season match counters (`segments[].stats.Matches`) for
 * a single game. Each segment is one mode/season (e.g. 5v5 premade, league,
 * etc.); `stats.Matches` is the actual number of matches, which is the number
 * shown on the profile. Any failure for a game resolves to 0 (best-effort).
 */
const getGameMatchTotal = async (
  playerId: string,
  game: (typeof ACTIVITY_GAMES)[number],
  apiKey: string,
): Promise<number> => {
  try {
    const response = await axios.get(
      `https://open.faceit.com/data/v4/players/${encodeURIComponent(playerId)}/stats/${game}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: FACEIT_TIMEOUT_MS,
        validateStatus: (status) => status === 200 || status === 404,
      },
    );

    if (response.status !== 200) {
      return 0;
    }

    const segments = response.data?.segments as
      | Array<{ stats?: Record<string, unknown> }>
      | undefined;
    if (!segments) {
      return 0;
    }

    let total = 0;
    segments.forEach((segment) => {
      const raw = segment.stats?.Matches;
      const parsed = Number.isFinite(Number(raw)) ? Number(raw) : null;
      if (parsed !== null && parsed > 0) {
        total += parsed;
      }
    });
    return total;
  } catch (error) {
    console.error(
      `getFaceitBanStatus - getGameMatchTotal error for playerId ${playerId} game ${game}:`,
      error,
    );
    return 0;
  }
};

/**
 * Best-effort lookup of the player's total match count on FACEIT across the
 * CS games (CS2 + CS:GO). Used as an "activity" signal: a player who is
 * demonstrably active on a platform with an invasive anti-cheat is less likely
 * to be running cheats. Any failure resolves to null, so this never blocks or
 * breaks the report.
 */
const getPlayerMatches = async (
  playerId: string,
  apiKey: string,
): Promise<number | null> => {
  const games = await Promise.all(
    ACTIVITY_GAMES.map((game) => getGameMatchTotal(playerId, game, apiKey)),
  );

  const total = games.reduce((acc, value) => acc + value, 0);
  // There was no usable stats for any game (e.g. a FACEIT account that never
  // played CS) -> no activity signal, rather than a misleading 0.
  return games.every((value) => value === 0) ? null : total;
};

/**
 * Checks whether a Steam ID holds a ban on FACEIT.
 *
 * The FACEIT Data API player object does not expose a `banned` boolean, so we
 * first resolve the player (getting the faceit `player_id`) and then query the
 * player's bans endpoint. If the bans list contains any entry the account is
 * flagged as banned.
 *
 * This is deliberately best-effort: any failure (missing key, 404 for a player
 * without a FACEIT account, timeout, network error) resolves to `banned: false`
 * so a ban lookup never blocks or breaks the cheater-probability calculation.
 */
const getFaceitBanStatus = async (
  steamId: string,
): Promise<FaceitBanStatus> => {
  const { FACEIT_API_KEY } = process.env;

  if (!FACEIT_API_KEY) {
    return notBanned(null);
  }

  if (!STEAM64_ID_REGEX.test(steamId)) {
    return notBanned(null);
  }

  try {
    const playerResponse = await axios.get(
      `https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${encodeURIComponent(steamId)}`,
      {
        headers: { Authorization: `Bearer ${FACEIT_API_KEY}` },
        timeout: FACEIT_TIMEOUT_MS,
        validateStatus: (status) => status === 200 || status === 404,
      },
    );

    if (playerResponse.status !== 200) {
      // No FACEIT account linked to this Steam ID -> no ban/match data.
      return notBanned(null);
    }

    const playerId = playerResponse.data?.player_id as string | undefined;

    if (!playerId) {
      return notBanned(null);
    }

    // Use allSettled so a failure on `/bans` (e.g. an unexpected status that
    // makes axios throw) doesn't discard the `matches` count that resolved fine
    // in parallel — a 404/error on the bans list should never cost us a good
    // activity signal on a separate endpoint.
    const [bansResult, matchesResult] = await Promise.allSettled([
      axios.get(
        `https://open.faceit.com/data/v4/players/${encodeURIComponent(playerId)}/bans`,
        {
          headers: { Authorization: `Bearer ${FACEIT_API_KEY}` },
          timeout: FACEIT_TIMEOUT_MS,
        },
      ),
      getPlayerMatches(playerId, FACEIT_API_KEY),
    ]);

    const bannedItems =
      bansResult.status === 'fulfilled'
        ? (bansResult.value.data?.items as
            | Array<{ reason?: string; type?: string }>
            | undefined)
        : undefined;

    if (bansResult.status === 'rejected') {
      // Log without propagating: a /bans failure must not cost us the good
      // `matches` signal (that's why it's allSettled), but it MUST stay visible
      // so the route.ts monitoring grep for 'getFaceitBanStatus' catches 403/429
      // on the bans endpoint — silently dropping this would hide provider
      // throttling behind a plausible "not banned" result.
      console.error(
        `getFaceitBanStatus - /bans failed for playerId ${playerId} (treated as not banned), reason:`,
        bansResult.reason,
      );
    }

    // `getPlayerMatches` never rejects (it swallows its own errors and resolves
    // to null), so the allSettled matches entry is always fulfilled in practice
    // — but unwrap defensively so a hypothetical rejection still yields "no data".
    const matches =
      matchesResult.status === 'fulfilled' ? matchesResult.value : null;

    if (bannedItems && bannedItems.length > 0) {
      // A player can hold several bans; the strongest signal should win.
      // Prefer cheat > smurf > other, so an older "other" ban on index 0 can't
      // hide a later "Cheating" ban.
      const strongest = bannedItems.reduce<{
        reason: string | null;
        classification: BanClassification | null;
      }>(
        (acc, item) => {
          const reason = item.reason ?? item.type ?? null;
          const classification = classifyBanReason(reason);
          const rank = (c: BanClassification | null): number => {
            if (c === 'cheat') return 2;
            if (c === 'smurf') return 1;
            if (c === 'other') return 0;
            return -1;
          };
          return rank(classification) > rank(acc.classification)
            ? { reason, classification }
            : acc;
        },
        { reason: null, classification: null },
      );

      return {
        banned: true,
        reason: strongest.reason,
        playerId,
        classification: strongest.classification,
        matches,
      };
    }

    return { banned: false, reason: null, playerId, classification: null, matches };
  } catch (error) {
    console.error(`getFaceitBanStatus - error for steamId ${steamId}:`, error);
    return notBanned(null);
  }
};

export default getFaceitBanStatus;

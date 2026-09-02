import axios from 'axios';
import classifyBanReason, {
  BanClassification,
} from './classifyBanReason';

const STEAM64_ID_REGEX = /^\d{17}$/;
const FACEIT_TIMEOUT_MS = 8000;

export type FaceitBanStatus = {
  banned: boolean;
  reason: string | null;
  playerId: string | null;
  classification: BanClassification | null;
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
    return { banned: false, reason: null, playerId: null, classification: null };
  }

  if (!STEAM64_ID_REGEX.test(steamId)) {
    return { banned: false, reason: null, playerId: null, classification: null };
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
      // No FACEIT account linked to this Steam ID -> no ban.
      return { banned: false, reason: null, playerId: null, classification: null };
    }

    const playerId = playerResponse.data?.player_id as string | undefined;

    if (!playerId) {
      return { banned: false, reason: null, playerId: null, classification: null };
    }

    const bansResponse = await axios.get(
      `https://open.faceit.com/data/v4/players/${encodeURIComponent(playerId)}/bans`,
      {
        headers: { Authorization: `Bearer ${FACEIT_API_KEY}` },
        timeout: FACEIT_TIMEOUT_MS,
      },
    );

    const items = bansResponse.data?.items as
      | Array<{ reason?: string; type?: string }>
      | undefined;

    if (items && items.length > 0) {
      // A player can hold several bans; the strongest signal should win.
      // Prefer cheat > smurf > other, so an older "other" ban on index 0 can't
      // hide a later "Cheating" ban.
      const strongest = items.reduce<{
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
      };
    }

    return { banned: false, reason: null, playerId, classification: null };
  } catch (error) {
    console.error(`getFaceitBanStatus - error for steamId ${steamId}:`, error);
    return { banned: false, reason: null, playerId: null, classification: null };
  }
};

export default getFaceitBanStatus;

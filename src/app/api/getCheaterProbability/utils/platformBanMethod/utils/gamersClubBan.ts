import axios from 'axios';
import classifyBanReason, {
  BanClassification,
} from './classifyBanReason';

const STEAM64_ID_REGEX = /^\d{17}$/;
const GAMERSCLUB_PROXY_TIMEOUT_MS = 8000;

export type GamersClubBanStatus = {
  banned: boolean;
  reason: string | null;
  name: string | null;
  classification: BanClassification | null;
  /**
   * Matches/sessions the player has on GamersClub (scraped by the proxy from
   * the profile page). Best-effort: null when unavailable. Used to discount
   * the cheater probability for players active on this invasive-anti-cheat
   * platform.
   */
  matches: number | null;
};

/**
 * Shared "no data / not banned" value (single source of truth for the empty
 * fallback). Imported by `platformBanMethod/index.ts` for the timeout path so
 * the wrapper and call sites don't each hand-maintain a duplicate shape.
 */
export const gamersClubNotBannedStatus: GamersClubBanStatus = {
  banned: false,
  reason: null,
  name: null,
  classification: null,
  matches: null,
};

const notBanned = (): GamersClubBanStatus => gamersClubNotBannedStatus;

/**
 * Checks whether a Steam ID is banned on GamersClub.
 *
 * GamersClub has no public API, so the check goes through the local proxy
 * (LOCAL_PROXY_URL -> /api/gamersclub/:steamId) which scrapes the profile page
 * with the session cookie. The proxy returns a `banned` flag and, when known,
 * the punishment reason.
 *
 * Deliberately best-effort: any failure (missing proxy, timeout, network
 * error, proxy 5xx) resolves to `banned: false` so the lookup never blocks or
 * breaks the cheater-probability calculation.
 */
const getGamersClubBanStatus = async (
  steamId: string,
): Promise<GamersClubBanStatus> => {
  const proxyUrl = process.env.LOCAL_PROXY_URL;

  if (!proxyUrl) {
    return notBanned();
  }

  if (!STEAM64_ID_REGEX.test(steamId)) {
    return notBanned();
  }

  try {
    const cleanedUrl = proxyUrl.replace(/\/$/, '');
    const response = await axios.get(
      `${cleanedUrl}/api/gamersclub/${encodeURIComponent(steamId)}?includeBan=true`,
      { timeout: GAMERSCLUB_PROXY_TIMEOUT_MS },
    );

    const data = response.data as {
      banned?: boolean;
      banReason?: string | null;
      name?: string | null;
      sessions?: number | null;
    } | null;

    const banned = Boolean(data?.banned);
    const reason = banned ? (data?.banReason ?? null) : null;

    const rawMatches = data?.sessions;
    const matches =
      typeof rawMatches === 'number' && Number.isFinite(rawMatches) && rawMatches >= 0
        ? rawMatches
        : null;

    return {
      banned,
      reason,
      name: data?.name ?? null,
      classification: banned ? classifyBanReason(reason) : null,
      matches,
    };
  } catch (error) {
    console.error(
      `getGamersClubBanStatus - error for steamId ${steamId}:`,
      error,
    );
    return notBanned();
  }
};

export default getGamersClubBanStatus;

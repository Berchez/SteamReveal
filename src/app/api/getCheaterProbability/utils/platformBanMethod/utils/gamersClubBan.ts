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
};

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
    return { banned: false, reason: null, name: null, classification: null };
  }

  if (!STEAM64_ID_REGEX.test(steamId)) {
    return { banned: false, reason: null, name: null, classification: null };
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
    } | null;

    const banned = Boolean(data?.banned);
    const reason = banned ? (data?.banReason ?? null) : null;

    return {
      banned,
      reason,
      name: data?.name ?? null,
      classification: banned ? classifyBanReason(reason) : null,
    };
  } catch (error) {
    console.error(
      `getGamersClubBanStatus - error for steamId ${steamId}:`,
      error,
    );
    return { banned: false, reason: null, name: null, classification: null };
  }
};

export default getGamersClubBanStatus;

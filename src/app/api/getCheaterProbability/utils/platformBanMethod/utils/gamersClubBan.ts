import axios from 'axios';
import classifyBanReason, {
  BanClassification,
} from './classifyBanReason';

const STEAM64_ID_REGEX = /^\d{17}$/;
const GAMERSCLUB_PROXY_TIMEOUT_MS = 8000;
// Single retry for transient proxy failures (tunnel blip, slow scrape).
// Worst case is attempts × timeout + inter-attempt delays
// (8s + 1s + 8s = 17s, see GAMERSCLUB_WORST_CASE_BUDGET_MS below) and the
// outer withinBanTimeout budget is derived from that export — so retuning
// here automatically moves the wrapper. Do NOT raise the timeout instead —
// the route runs on serverless with execution caps, and a longer single
// attempt only moves the blow-up point.
const GC_RETRY_ATTEMPTS = 2;
const GC_RETRY_DELAY_MS = 1000;

/**
 * Worst-case wall-clock budget of one getGamersClubBanStatus call:
 * every attempt can burn the full proxy timeout, plus the inter-attempt
 * delay. Exported so platformBanMethod/index.ts derives its outer
 * BAN_TIMEOUT_MS from the real lane budgets instead of a magic number —
 * retuning the timeout/retry/delay above automatically moves the wrapper.
 */
export const GAMERSCLUB_WORST_CASE_BUDGET_MS =
  GAMERSCLUB_PROXY_TIMEOUT_MS * GC_RETRY_ATTEMPTS +
  GC_RETRY_DELAY_MS * (GC_RETRY_ATTEMPTS - 1);

export type GamersClubBanStatus = {
  banned: boolean;
  reason: string | null;
  name: string | null;
  classification: BanClassification | null;
  /**
   * Whether the proxy lookup actually completed. False on every failure
   * path (missing proxy, invalid id, timeout, network/5xx) AND on a 200
   * whose payload carries no boolean `banned` verdict (tunnel/Cloudflare
   * intermediaries can answer 200 with a non-JSON body) — the client
   * uses it to avoid caching a "clean" verdict that was never verified.
   * True only for a 200 that actually carries the verdict, including a
   * verified-clean profile. The proxy always answers 200 with
   * `banned: boolean` (false when the player simply has no GC record),
   * so there is no "no account" 404 to map — unlike the FACEIT lane.
   */
  checked: boolean;
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
  checked: false,
};

const notBanned = (): GamersClubBanStatus => ({ ...gamersClubNotBannedStatus });

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Only transient failures deserve a second attempt: timeouts / network
// errors (no HTTP response at all) and 5xx from the proxy/tunnel. A 4xx
// (expired cf_clearance/session, bad request) is deterministic —
// retrying it just burns another full timeout and hammers the proxy.
// Duck-typed instead of axios.isAxiosError so it also covers wrapped or
// mocked errors (and stays unit-testable without the real axios shape).
const getResponseStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const { response } = error as { response?: unknown };
  if (!response || typeof response !== 'object') return undefined;
  const { status } = response as { status?: unknown };
  return typeof status === 'number' ? status : undefined;
};

const isRetryableGcError = (error: unknown): boolean => {
  const status = getResponseStatus(error);
  if (status === undefined) return true;
  return status >= 500;
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
  * error, proxy 5xx — or a 200 whose payload carries no boolean `banned`
  * verdict) resolves to `banned: false` so the lookup never blocks or
  * breaks the cheater-probability calculation. The unverified cases keep
  * `checked: false` so the client won't cache them as clean.
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

  const cleanedUrl = proxyUrl.replace(/\/$/, '');
  const url = `${cleanedUrl}/api/gamersclub/${encodeURIComponent(steamId)}?includeBan=true`;

  // Recursive attempts (not a loop) so a single transient blip gets exactly
  // one more chance without tripping no-await-in-loop/no-continue.
  // Only the NETWORK call lives inside the try: parsing is deterministic,
  // so a malformed payload fails identically on every attempt and must
  // resolve (unchecked) rather than burn the retry. The never-reject
  // contract still holds — a parse failure resolves to "not banned" via
  // its own guard below, it just doesn't retry first.
  const fetchOnce = async (attempt: number): Promise<GamersClubBanStatus> => {
    let response: { data: unknown } | undefined;
    try {
      response = await axios.get(url, {
        timeout: GAMERSCLUB_PROXY_TIMEOUT_MS,
      });
    } catch (error) {
      if (attempt < GC_RETRY_ATTEMPTS && isRetryableGcError(error)) {
        console.warn(
          `getGamersClubBanStatus - attempt ${attempt}/${GC_RETRY_ATTEMPTS} failed for steamId ${steamId}, retrying:`,
          error instanceof Error ? error.message : error,
        );
        await delay(GC_RETRY_DELAY_MS);
        return fetchOnce(attempt + 1);
      }
      console.error(
        `getGamersClubBanStatus - error for steamId ${steamId}:`,
        error,
      );
      return notBanned();
    }

    try {
      const data = response?.data as {
        banned?: boolean;
        banReason?: string | null;
        name?: string | null;
        sessions?: number | null;
      } | null;

      // A 200 only counts as verified when the payload actually carries the
      // verdict: intermediaries can answer 200 with a non-JSON body, and
      // `Boolean(undefined)` would otherwise launder that into a "verified
      // clean" that the client caches. Strict `=== true` for the same
      // reason — a truthy non-boolean must never read as banned, either.
      const verified = typeof data?.banned === 'boolean';
      const banned = data?.banned === true;
      const reason = banned ? (data?.banReason ?? null) : null;

      const rawMatches = data?.sessions;
      const matches =
        typeof rawMatches === 'number' &&
        Number.isFinite(rawMatches) &&
        rawMatches >= 0
          ? rawMatches
          : null;

      return {
        banned,
        reason,
        name: data?.name ?? null,
        classification: banned ? classifyBanReason(reason) : null,
        matches,
        checked: verified,
      };
    } catch (parseError) {
      console.error(
        `getGamersClubBanStatus - unparseable payload for steamId ${steamId}:`,
        parseError,
      );
      return notBanned();
    }
  };

  return fetchOnce(1);
};

export default getGamersClubBanStatus;

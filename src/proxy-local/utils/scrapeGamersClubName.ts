import axios from 'axios';
import * as cheerio from 'cheerio';
import getErrorMessage from './getErrorMessage';
import withRetry from './withRetry';
import { getCachedGcName, setCachedGcName } from './gcNameCache';

const BASE_URL = 'https://gamersclub.com.br';

const GAMERSCLUB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.108 Safari/537.36';

/**
 * Reads the GamersClub session cookie from the environment instead of a
 * hardcoded value, since a hardcoded auth token committed to the repo is a
 * security risk (and expires every 7 days anyway).
 */
const getSessionCookie = (): string => {
  const sessionValue = process.env.GAMERSCLUB_SESSION_COOKIE;
  if (!sessionValue) {
    throw new Error(
      'GAMERSCLUB_SESSION_COOKIE environment variable is not set',
    );
  }
  return `gclubsess=${sessionValue}`;
};

/**
 * Decides whether a failed request is worth retrying.
 * - 429 / 5xx: transient, upstream is overloaded or hiccuping -> retry.
 * - No response at all (timeout, network error, DNS failure): also
 *   transient -> retry.
 * - Any other 4xx (401/403/404/...): a definitive rejection that a retry
 *   won't fix (bad cookie, endpoint doesn't exist, etc) -> don't waste
 *   attempts and time on it.
 */
const isRetryableAxiosError = (err: unknown): boolean => {
  if (!axios.isAxiosError(err)) return true;
  const status = err.response?.status;
  if (status === undefined) return true;
  return status === 429 || status >= 500;
};

/**
 * Outcome of resolvePlayerUrl, explicit about *why* there's no URL — this
 * matters for caching. Only 'not_found' is a confirmed, GamersClub-told-us
 * outcome; 'unknown' means we genuinely couldn't tell (unexpected status
 * that slipped past validateStatus) and must NOT be cached as a miss.
 */
type PlayerLookupResult =
  | { status: 'found'; url: string }
  | { status: 'not_found' }
  | { status: 'unknown' };

/**
 * Resolves the GamersClub player page URL for a given Steam ID.
 * The /buscar endpoint responds with a 307 redirect to /player/{id}.
 *
 * `validateStatus` is set to also accept 307 as a "valid" response instead
 * of the axios default (2xx only). A 307 here is the expected "player
 * found" outcome for this endpoint, not an error condition — letting axios
 * throw for it would make withRetry treat a successful search as a failure
 * (retrying it pointlessly) and would prevent reportSuccess() from ever
 * firing for the common case, since it only runs on the non-throwing path.
 */
const resolvePlayerUrl = async (
  steamId: string,
  cookie: string,
): Promise<PlayerLookupResult> => {
  const steamProfileUrl = `https://steamcommunity.com/profiles/${steamId}/`;
  const searchUrl = `${BASE_URL}/buscar?busca=${encodeURIComponent(steamProfileUrl)}`;

  console.debug(`[GamersClub] Searching player at ${searchUrl}`);

  const response = await withRetry(
    () =>
      axios.get(searchUrl, {
        maxRedirects: 0,
        timeout: 10000,
        headers: {
          'User-Agent': GAMERSCLUB_USER_AGENT,
          Cookie: cookie,
        },
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 307,
      }),
    { shouldRetry: isRetryableAxiosError },
  );

  const { status } = response;
  const location = response.headers?.location;

  console.debug(
    `[GamersClub] Search response status: ${status}, Location: ${location}`,
  );

  if (status === 307 && location) {
    const url = location.startsWith('http')
      ? location
      : `${BASE_URL}${location}`;
    return { status: 'found', url };
  }

  if (status >= 200 && status < 300) {
    // A 2xx response here means no redirect happened — GamersClub itself
    // is telling us there's no player for this Steam ID. This is the ONLY
    // branch that represents a confirmed "not found", safe to cache.
    return { status: 'not_found' };
  }

  // Shouldn't normally happen given validateStatus above, but guards
  // against an unexpected status slipping through. Deliberately NOT
  // treated as 'not_found' — we don't actually know that here.
  console.warn(
    `GamersClub: Unexpected response status ${status} for Steam ID ${steamId}.`,
  );
  return { status: 'unknown' };
};

/**
 * Extracts the player's public name from the profile page HTML.
 * Looking for: <h6 class="gc-list-title">Nome</h6> followed by <p class="gc-list-text">...</p>
 * Note: 'Nome' is the actual Portuguese label rendered in GamersClub's HTML, not a
 * leftover comment — it can't be translated without breaking the scraper.
 */
const extractNameFromProfile = (html: string): string | null => {
  const $profile = cheerio.load(html);
  let name: string | null = null;

  $profile('.gc-list-item').each((_, element) => {
    const title = $profile(element).find('.gc-list-title').text().trim();
    if (title === 'Nome') {
      name = $profile(element).find('.gc-list-text').text().trim();
      return false; // Stop iterating once the name field is found
    }
    return true;
  });

  return name;
};

/**
 * Fetches and scrapes the public name from a GamersClub profile.
 * @param steamId - The Steam ID (can be in any format)
 * @returns The player's public name or null if not found
 */
const scrapeGamersClubName = async (
  steamId: string,
): Promise<string | null> => {
  const cached = getCachedGcName(steamId);
  if (cached) {
    console.debug(
      `[GamersClub] Cache hit for Steam ID ${steamId}: ${cached.name ?? '(not found)'}`,
    );
    return cached.name;
  }

  try {
    const cookie = getSessionCookie();
    const lookup = await resolvePlayerUrl(steamId, cookie);

    if (lookup.status === 'not_found') {
      console.warn(`GamersClub: No player URL found for Steam ID ${steamId}`);
      // Confirmed by GamersClub itself — safe to cache as a miss.
      setCachedGcName(steamId, null);
      return null;
    }

    if (lookup.status === 'unknown') {
      // We couldn't determine the outcome — return null for this call but
      // deliberately don't cache it, so the next lookup gets a fresh try.
      return null;
    }

    const { url: playerUrl } = lookup;

    console.debug(`[GamersClub] Fetching profile from ${playerUrl}`);

    const profileResponse = await withRetry(
      () =>
        axios.get(playerUrl, {
          timeout: 60000,
          headers: {
            'User-Agent': GAMERSCLUB_USER_AGENT,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            Cookie: cookie,
          },
        }),
      { shouldRetry: isRetryableAxiosError },
    );

    console.debug(
      `[GamersClub] Profile page status: ${profileResponse.status}`,
    );

    const name = extractNameFromProfile(profileResponse.data);

    if (!name) {
      // The profile page loaded fine but the expected "Nome" field wasn't
      // found. This is ambiguous — could be a genuinely empty field, or
      // GamersClub having changed their HTML structure — so it's NOT
      // cached, to avoid baking a scraper breakage into a 90-day "miss".
      console.warn(`GamersClub: Name field not found for Steam ID ${steamId}`);
      return null;
    }

    console.debug(`[GamersClub] Successfully extracted name: ${name}`);
    setCachedGcName(steamId, name);
    return name;
  } catch (error) {
    // Network errors, timeouts, missing cookie, non-retryable 4xx, etc.
    // None of these are a confirmed outcome, so nothing gets cached here.
    console.error(
      `GamersClub scraping error for Steam ID ${steamId}:`,
      getErrorMessage(error),
    );
    return null;
  }
};

export default scrapeGamersClubName;

import axios from 'axios';
import * as cheerio from 'cheerio';
import getErrorMessage from './getErrorMessage';
import applyRateLimit from './rateLimit';

const BASE_URL = 'https://gamersclub.com.br';

const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';
const PROFILE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

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
 * Resolves the GamersClub player page URL for a given Steam ID.
 * The /buscar endpoint responds with a 307 redirect to /player/{id}.
 */
const resolvePlayerUrl = async (
  steamId: string,
  cookie: string,
): Promise<string | null> => {
  const steamProfileUrl = `https://steamcommunity.com/profiles/${steamId}/`;
  const searchUrl = `${BASE_URL}/buscar?busca=${encodeURIComponent(steamProfileUrl)}`;

  console.debug(`[GamersClub] Searching player at ${searchUrl}`);

  await applyRateLimit();

  try {
    // Request with maxRedirects: 0 to capture the redirect instead of following it
    await axios.get(searchUrl, {
      maxRedirects: 0,
      timeout: 10000,
      headers: {
        'User-Agent': SEARCH_USER_AGENT,
        Cookie: cookie,
      },
    });
    // A 2xx response here means no redirect happened, i.e. no player was found
    return null;
  } catch (axiosError) {
    if (!axios.isAxiosError(axiosError)) throw axiosError;

    const status = axiosError.response?.status;
    const location = axiosError.response?.headers?.location;

    console.debug(
      `[GamersClub] Search response status: ${status}, Location: ${location}`,
    );

    if (status === 307 && location) {
      return location.startsWith('http') ? location : `${BASE_URL}${location}`;
    }

    console.warn(
      `GamersClub: Unexpected response status ${status} for Steam ID ${steamId}. Location: ${location}`,
    );
    return null;
  }
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
  try {
    const cookie = getSessionCookie();
    const playerUrl = await resolvePlayerUrl(steamId, cookie);

    if (!playerUrl) {
      console.warn(`GamersClub: No player URL found for Steam ID ${steamId}`);
      return null;
    }

    console.debug(`[GamersClub] Fetching profile from ${playerUrl}`);

    await applyRateLimit();

    const profileResponse = await axios.get(playerUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': PROFILE_USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        Cookie: cookie,
      },
    });

    console.debug(
      `[GamersClub] Profile page status: ${profileResponse.status}`,
    );

    const name = extractNameFromProfile(profileResponse.data);

    if (!name) {
      console.warn(`GamersClub: Name field not found for Steam ID ${steamId}`);
    } else {
      console.debug(`[GamersClub] Successfully extracted name: ${name}`);
    }

    return name;
  } catch (error) {
    console.error(
      `GamersClub scraping error for Steam ID ${steamId}:`,
      getErrorMessage(error),
    );
    return null;
  }
};

export default scrapeGamersClubName;

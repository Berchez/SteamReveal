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
 * The profile page shows match counters in "history cards" of the form
 * `<p class="gc-card-history-text">1419 <span>Partidas</span></p>` — one card per
 * Lobby/season/mode. The same player can have several such cards (e.g. a CS:GO
 * lobby and a separate CS2 lobby), so the total match history is the SUM across
 * all matching cards — NOT the largest one. The label is the text right after
 * the number (pt: "Partidas", en: "Matches"), so we match on that. Best-effort:
 * returns the summed counter or null if no card matches — so a markup change
 * simply turns the signal off without breaking the scrape or the report.
 */
// Matches the counter label as a whole word (pt: "Partida"/"Partidas",
// en: "Match"/"Matches"), so a string like "próxima partida" or "partidas
// perdidas" (a label, not a total) doesn't count as an activity counter.
const ACTIVITY_COUNTER_LABEL_REGEX = /\b(partidas?|matches?)\b/i;

const normalizeNumber = (input: string): number | null => {
  // DEPENDS on the page coming back in pt-BR: the request pins
  // `Accept-Language: pt-BR,pt;q=0.9,...` (see the proxy call below), so
  // GamersClub renders pt-BR thousands separators as dots ("2.500"). If that
  // header ever changes to a locale that uses commas for thousands (e.g.
  // en-US "1,250"), this pt-BR parse would mis-read "1,250" as 1.25 — keep the
  // header and this parser in sync. Strip anything non-numeric except . and ,
  // first (also drops the trailing unit like "Partidas"/"Matches").
  const cleaned = input.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;

  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

const extractActivityFromProfile = (html: string): number | null => {
  const $profile = cheerio.load(html);
  let totalActivity: number | null = null;
  let anyMatch = false;

  $profile('.gc-card-history-text').each((_, element) => {
    const text = $profile(element).text().trim();
    if (!ACTIVITY_COUNTER_LABEL_REGEX.test(text)) return;

    const value = normalizeNumber(text);
    if (value === null) return;

    anyMatch = true;
    totalActivity = (totalActivity ?? 0) + value;
  });

  return anyMatch && totalActivity !== null ? totalActivity : null;
};

// GamersClub renders a prominent alert on a punished profile page with the
// text "MEMBRO BANIDO NA GAMERS CLUB" (pt) / "MEMBER BANNED AT GAMERS CLUB"
// (en) — the language depends on the Accept-Language header sent in the
// request. We treat that alert as the authoritative signal that the account
// is banned on the platform. Note: detecting bans via the page <title> is NOT
// reliable — GamersClub prefixes the title with the player's nickname, so a
// player literally nicknamed "Punishment" would be a false positive.

/**
 * Extracts whether the profile page indicates a punishment (block/suspension)
 * from its HTML. Looks for the "BANIDO/BANNED" alert rendered only on
 * punished/banned profiles (locale-independent), and surfaces its reason when
 * present.
 */
const extractBanStatus = (
  html: string,
): { banned: boolean; banReason: string | null } => {
  const $profile = cheerio.load(html);
  // Risk: if GamersClub ever puts another `strong.alert-color` before the ban
  // alert (promo banner, maintenance note), .first() would silently miss the
  // real ban. The current tests cover this selector; revisit if the page shape
  // changes. Hard to make more specific without a stable surrounding marker.
  const alert = $profile('strong.alert-color').first();
  const alertText = alert.text().trim();

  const isBannedMarker = /banid|banned/i.test(alertText);
  if (!isBannedMarker) {
    return { banned: false, banReason: null };
  }

  // Scope the reason to the same alert container as the "BANIDO" marker so a
  // page with multiple `.alert-danger` blocks can't pull the wrong reason,
  // which would feed a wrong cheat/smurf classification.
  const reason = alert
    .closest('.alert-danger')
    .find('span.primary-color')
    .first()
    .text()
    .trim();

  return {
    banned: true,
    banReason: reason || alertText,
  };
};

export type GamersClubProfile = {
  name: string | null;
  banned: boolean;
  banReason: string | null;
  /**
   * Number of matches/sessions the player has on GamersClub, scraped from the
   * profile page. Best-effort: null when no recognizable activity counter is
   * present (or the scrape fails). Used to discount the cheater probability for
   * players active on this invasive-anti-cheat platform.
   */
  sessions: number | null;
};

/**
 * Fetches the GamersClub profile page and extracts the public name plus the
 * punishment/ban status. Never uses the name cache here — the cheater-report
 * ban check must always reflect the current profile rather than a possibly
 * stale cached name, so this always does a fresh scrape.
 */
const scrapeGamersClubProfile = async (
  steamId: string,
): Promise<GamersClubProfile | null> => {
  if (!steamId) return null;

  const cookie = getSessionCookie();
  const lookup = await resolvePlayerUrl(steamId, cookie);

  if (lookup.status === 'not_found') {
    // Confirmed by GamersClub itself that this Steam ID has no profile.
    // Cache the miss so we don't re-scrape it within the TTL.
    setCachedGcName(steamId, null);
    return { name: null, banned: false, banReason: null, sessions: null };
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

  const html = profileResponse.data as string;
  const name = extractNameFromProfile(html);
  const { banned, banReason } = extractBanStatus(html);
  const sessions = extractActivityFromProfile(html);

  // The profile page loaded fine but the expected "Nome" field wasn't found.
  // This is ambiguous — could be a genuinely empty field, or GamersClub
  // having changed their HTML structure — so it's NOT cached, to avoid
  // baking a scraper breakage into a 90-day "miss".
  if (name) {
    setCachedGcName(steamId, name);
  }

  return { name, banned, banReason, sessions };
};

/**
 * Fetches and scrapes the public name from a GamersClub profile.
 * @param steamId - The Steam ID (can be in any format)
 * @param allowScrape - Whether to perform a fresh scrape if not in cache
 * @returns The player's public name or null if not found
 */
const scrapeGamersClubName = async (
  steamId: string,
  allowScrape = true,
): Promise<string | null> => {
  const cached = getCachedGcName(steamId);
  if (cached) {
    console.debug(
      `[GamersClub] Cache hit for Steam ID ${steamId}: ${cached.name ?? '(not found)'}`,
    );
    return cached.name;
  }

  if (!allowScrape) {
    console.debug(
      `[GamersClub] Cache miss for Steam ID ${steamId} and scraping is disabled.`,
    );
    return null;
  }

  try {
    const profile = await scrapeGamersClubProfile(steamId);
    return profile?.name ?? null;
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

/**
 * Checks whether a Steam ID is banned/punished on GamersClub. Always does a
 * fresh scrape (never reuses the cached name) so the result reflects the
 * current profile. Best-effort: on any error it resolves to "not banned"
 * rather than throwing, so the caller's analysis never breaks.
 */
const scrapeGamersClubBan = async (
  steamId: string,
): Promise<GamersClubProfile> => {
  try {
    const profile = await scrapeGamersClubProfile(steamId);
    return (
      profile ?? { name: null, banned: false, banReason: null, sessions: null }
    );
  } catch (error) {
    console.error(
      `GamersClub ban scraping error for Steam ID ${steamId}:`,
      getErrorMessage(error),
    );
    return { name: null, banned: false, banReason: null, sessions: null };
  }
};

export { scrapeGamersClubBan, scrapeGamersClubProfile };
export default scrapeGamersClubName;

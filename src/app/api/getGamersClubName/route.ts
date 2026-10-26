import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import axios from 'axios';
import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import GC_NAME_CACHE_SECONDS from '@/lib/gamersClubNameCache';

export const revalidate = 0;

type GcNameLookup = {
  gcName: string | null;
  notFound: boolean;
  /** True only for a name or a GamersClub-confirmed miss. */
  confirmed: boolean;
  /**
   * True when the lookup could not be performed at all because the local
   * proxy (the scraper that talks to GamersClub) is unreachable or
   * misconfigured. Distinct from `notFound`: "the scraper is down" must
   * never be presented as "this player has no GamersClub profile", and the
   * UI uses it to hold back the sign-in upsell while the feature is down.
   */
  unavailable: boolean;
};

/**
 * Null has two meanings here: "GamersClub confirmed this Steam ID has no
 * profile" and "we could not tell" (scraping disabled, timeout, parser
 * break). Only the former is safe to persist for three days. Throwing from
 * the cached callback keeps the latter out of Next's cache while still
 * returning a normal 200/null response to the client.
 */
class GcNameNotCacheableError extends Error {
  constructor(readonly result: GcNameLookup) {
    super('GC Name lookup was not a confirmed outcome');
    this.name = 'GcNameNotCacheableError';
  }
}

const fetchGcNameFromProxy = async (
  steamId: string,
  allowScrape: boolean,
): Promise<GcNameLookup> => {
  const scraperUrl = process.env.LOCAL_PROXY_URL;

  if (!scraperUrl) {
    return {
      gcName: null,
      notFound: false,
      confirmed: false,
      unavailable: true,
    };
  }

  try {
    const cleanedUrl = scraperUrl.replace(/\/$/, '');
    const queryParams = new URLSearchParams({
      allowScrape: String(allowScrape),
    });
    const targetUrl = `${cleanedUrl}/api/gamersclub/${encodeURIComponent(steamId)}?${queryParams.toString()}`;
    const response = await axios.get(targetUrl, {
      timeout: 60000,
    });

    if (response.status !== 200 || !response.data) {
      return {
        gcName: null,
        notFound: false,
        confirmed: false,
        unavailable: true,
      };
    }

    const gcName =
      typeof response.data.name === 'string' ? response.data.name : null;
    const notFound = response.data.notFound === true;

    return {
      gcName,
      notFound,
      confirmed: gcName !== null || notFound,
      unavailable: false,
    };
  } catch (error) {
    logRouteError('getGamersClubName [local proxy]', error, { steamId });
    return {
      gcName: null,
      notFound: false,
      confirmed: false,
      unavailable: true,
    };
  }
};

const getGcNameCached = unstable_cache(
  async (steamId: string, allowScrape: boolean): Promise<GcNameLookup> => {
    const result = await fetchGcNameFromProxy(steamId, allowScrape);
    if (!result.confirmed) {
      throw new GcNameNotCacheableError(result);
    }
    return result;
  },
  ['gamersclub-name'],
  {
    revalidate: GC_NAME_CACHE_SECONDS,
    tags: ['gamersclub-name'],
  },
);

const getGcNameForRequest = (steamId: string, allowScrape: boolean) =>
  process.env.NODE_ENV === 'test'
    ? fetchGcNameFromProxy(steamId, allowScrape)
    : getGcNameCached(steamId, allowScrape);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { steamId, allowScrape: rawAllowScrape } = body;

    if (!steamId || typeof steamId !== 'string') {
      return errorResponse(
        'Invalid or missing steamId parameter',
        400,
        'INVALID_REQUEST',
      );
    }

    // Keep the historical default: only an explicit `false` disables the
    // scrape (the analytics backfill omits the field and expects a lookup).
    const allowScrape = rawAllowScrape !== false;

    try {
      const result = await getGcNameForRequest(steamId, allowScrape);
      return NextResponse.json(
        {
          steamId,
          gcName: result.gcName,
          notFound: result.notFound,
          unavailable: result.unavailable,
        },
        { status: 200 },
      );
    } catch (error) {
      if (error instanceof GcNameNotCacheableError) {
        return NextResponse.json(
          {
            steamId,
            gcName: error.result.gcName,
            notFound: error.result.notFound,
            unavailable: error.result.unavailable,
          },
          { status: 200 },
        );
      }
      throw error;
    }
  } catch (error) {
    // `instanceof SyntaxError` alone misses errors thrown from another realm
    // (undici's Request.json() is one such case), so also match by name.
    const errorName =
      typeof error === 'object' && error !== null && 'name' in error
        ? (error as { name?: unknown }).name
        : null;
    if (error instanceof SyntaxError || errorName === 'SyntaxError') {
      logRouteError('getGamersClubName', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getGamersClubName', error);
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}

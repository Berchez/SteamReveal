import { cache } from 'react';
import { isSteamId64 } from '@/lib/steamId';
import getSteamApiKey from '@/lib/getSteamApiKey';
import withTimeout from '@/lib/withTimeout';

export interface SteamIdentity {
  nickname: string;
  avatarUrl: string;
}

const AVATAR_TIMEOUT_MS = 4000;

/**
 * Cross-request memo for the navbar avatar: react.cache dedupes only
 * within one request, so without this every logged-in navigation would
 * cost a Steam round-trip on the critical path of every page. Entries
 * live 10 minutes (avatars/nicknames change rarely; a stale letter for a
 * few minutes is invisible) INCLUDING nulls — during a Steam outage the
 * fallback must also be cheap, not a 4s timeout per navigation. Bounded
 * FIFO at 500 entries so a crawler can't grow it without limit. Like the
 * rate limiter, this memo is per-instance (not shared across serverless
 * instances), so multi-instance hit rates are lower than single-host —
 * accepted, same as every other in-memory cache in this repo.
 */
const IDENTITY_TTL_MS = 10 * 60 * 1000;
const IDENTITY_CACHE_MAX = 500;
const identityCache = new Map<
  string,
  { identity: SteamIdentity | null; expiresAt: number }
>();

/** Test seam: the TTL cache outlives single calls by design. */
export const clearSteamIdentityCache = (): void => {
  identityCache.clear();
};

const writeCachedIdentity = (
  steamId: string,
  identity: SteamIdentity | null,
): void => {
  if (identityCache.size >= IDENTITY_CACHE_MAX) {
    const oldest = identityCache.keys().next();
    if (!oldest.done) identityCache.delete(oldest.value);
  }
  identityCache.set(steamId, {
    identity,
    expiresAt: Date.now() + IDENTITY_TTL_MS,
  });
};

/**
 * Deterministic hermetic avatar for mock mode (Playwright runs with
 * DEV_TEST_MODE=1): a data-URI pixel needs no network AND no next/image
 * remote-domain entry, so e2e never touches the real Steam API for the
 * navbar — the suite's "no real Steam" rule holds end to end. Also means
 * local DEV_TEST_MODE runs show the placeholder, never your real avatar.
 */
const MOCK_AVATAR_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface SteamPlayerSummary {
  personaname?: unknown;
  avatarmedium?: unknown;
}

/**
 * Minimal public identity for the navbar avatar (Steam OpenID era).
 *
 * Calls GetPlayerSummaries with plain fetch — deliberately NOT the
 * steamapi lib: bundling steamapi into a page-tree Server Component
 * drags its ESM-only node-fetch dep into the page's server chunks, which
 * Next 14 dev intermittently fails to emit ("Cannot find module
 * './vendor-chunks/node-fetch@3.3.2.js"). One endpoint + two fields needs
 * no library. (steamapi stays where it already works: API routes and the
 * player page via getPlayerProfile.)
 *
 * Cached per request (react.cache) AND across requests (TTL above),
 * strictly best-effort: ANY failure (bad id, missing key, timeout,
 * empty profile) resolves to null and callers render the letter/SVG
 * fallback — an avatar must never break page render, and this function
 * never rejects.
 */
const getSteamIdentity = cache(
  async (steamId: string): Promise<SteamIdentity | null> => {
    if (!isSteamId64(steamId)) return null;
    const hit = identityCache.get(steamId);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.identity;

    if (process.env.DEV_TEST_MODE === '1') {
      const { isMockModeEnabled } = await import('@/mocks/devFixtures');
      if (isMockModeEnabled()) {
        const fixture: SteamIdentity = {
          nickname: 'MockUser',
          avatarUrl: MOCK_AVATAR_URL,
        };
        writeCachedIdentity(steamId, fixture);
        return fixture;
      }
    }

    const apiKey = getSteamApiKey();
    if (!apiKey) {
      writeCachedIdentity(steamId, null);
      return null;
    }

    try {
      const res = await withTimeout(
        fetch(
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`,
          { cache: 'no-store' },
        ),
        'getSteamIdentity: GetPlayerSummaries',
        AVATAR_TIMEOUT_MS,
      );
      if (!res.ok) {
        writeCachedIdentity(steamId, null);
        return null;
      }
      const body = (await res.json()) as {
        response?: { players?: SteamPlayerSummary[] };
      };
      const player = body?.response?.players?.[0];
      const avatarUrl = player?.avatarmedium;
      if (typeof avatarUrl !== 'string' || avatarUrl === '') {
        writeCachedIdentity(steamId, null);
        return null;
      }
      const nickname = player?.personaname;
      const identity: SteamIdentity = {
        nickname:
          typeof nickname === 'string' && nickname !== ''
            ? nickname
            : steamId,
        avatarUrl,
      };
      writeCachedIdentity(steamId, identity);
      return identity;
    } catch {
      writeCachedIdentity(steamId, null);
      return null;
    }
  },
);

export default getSteamIdentity;

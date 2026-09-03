import { cache } from 'react';
import SteamAPI from 'steamapi';
import type { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';
import withTimeout from '@/lib/withTimeout';
import { EnrichedUserSummary } from '@/@types/targetInfoJsonType';
import {
  CS_ACTIVE_ENRICHMENT_TIMEOUT_MS,
  getGamesSnapshot,
  isCounterStrikeActive,
} from '@/app/templates/Home/shared/analytics/homeAnalyticsUtils';

const steam = new SteamAPI(getSteamApiKey() ?? '');

const getPlayerProfile = cache(
  async (target: string): Promise<EnrichedUserSummary | undefined> => {
    // Dev/test fixture path: only taken when isMockModeEnabled() also
    // agrees (never NODE_ENV=production, never on Vercel). If
    // DEV_TEST_MODE is set but the guard fails, fall through to the real
    // Steam call below instead of returning undefined — a stray env var
    // must never be able to silently break profile lookups in production.
    if (process.env.DEV_TEST_MODE === '1') {
      try {
        const { isMockModeEnabled, makeMockProfile, isMockInvalidTarget } =
          await import('@/mocks/devFixtures');

        if (isMockModeEnabled()) {
          if (isMockInvalidTarget(target)) {
            return undefined;
          }
          return makeMockProfile(target) as unknown as UserSummary;
        }
        // Guard failed: fall through to the real implementation below.
      } catch (e) {
        // fall back to real behavior if fixtures can't be loaded
      }
    }

    try {
      const steamId = await steam.resolve(target);
      // Parallelize the two Steam calls so the SSR path isn't a serial chain
      // (resolve → getUserSummary → getUserOwnedGames). The owned-games call
      // is capped by a short dedicated timeout (CS_ACTIVE_ENRICHMENT_TIMEOUT_MS)
      // because it only feeds the optional CS-active cost gate: for large
      // libraries `includeAppInfo: true` is noticeably slower, so letting it
      // use the full 8s would hurt the very LCP/TTFB this seed path exists to
      // protect. The catch below guarantees the promise is never an unhandled
      // rejection (even if we return early below on a falsy profile) and makes
      // a failure resolve to `null` so `isCSActive` is left undefined
      // ("don't spend") instead of a wrong `false`.
      const ownedGamesPromise = withTimeout(
        steam.getUserOwnedGames(steamId, { includeAppInfo: true }),
        'getPlayerProfile: getUserOwnedGames',
        CS_ACTIVE_ENRICHMENT_TIMEOUT_MS,
      ).catch((error) => {
        // Best-effort: a failure here only leaves isCSActive off the seeded
        // profile (the prefetch gate treats unknown as "don't spend"). Log it
        // so provider / rate-limit issues on the enrichment are observable
        // rather than silent.
        // eslint-disable-next-line no-console
        console.error(
          `getPlayerProfile: getUserOwnedGames failed to enrich isCSActive for steamId=${steamId}`,
          error,
        );
        return null;
      });

      const profile = await steam.getUserSummary(steamId);
      const resolved = Array.isArray(profile) ? profile[0] : profile;
      if (!resolved) {
        return undefined;
      }
      // Ensure a plain serializable object is returned to avoid passing class
      // instances from Server -> Client components (Next.js runtime error).
      // JSON round-trip strips prototypes/methods, leaving a plain object.
      const plain: EnrichedUserSummary = JSON.parse(
        JSON.stringify(resolved),
      ) as EnrichedUserSummary;

      // Best-effort CS-active enrichment so the SSR/seeded path (direct load,
      // which skips /api/getUserInfo) still gates the cheater prefetch exactly
      // like the interactive search path does. A failure or timeout here must
      // never break the already-valid profile seed — it only leaves isCSActive
      // undefined, and the prefetch gate treats unknown as "don't spend money".
      const ownedGames = (await ownedGamesPromise) as Array<{
        name?: string;
        playtime_forever?: number;
        minutes?: number;
      }> | null;

      if (ownedGames) {
        const gamesSnapshot = getGamesSnapshot(ownedGames as never);
        plain.isCSActive = isCounterStrikeActive(gamesSnapshot);
      }

      return plain;
    } catch {
      return undefined;
    }
  },
);

export default getPlayerProfile;

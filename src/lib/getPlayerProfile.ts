import { cache } from 'react';
import SteamAPI from 'steamapi';
import type { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';
import { isOutOfSpanNumericId } from '@/lib/steamId';
import isBenignOwnedGamesError from '@/lib/isBenignOwnedGamesError';
import isSteamProfileNotFoundError from '@/lib/isSteamProfileNotFoundError';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';
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
      // A 17-digit param outside the valid SteamID64 span can never resolve
      // (steamapi's resolve() passes 17-digit inputs straight through, so
      // every Steam call below would fail with Bad Request/No players
      // found). Skip all Steam I/O and let the caller render its not-found
      // state — mirrors isValidTargetParam's API-route rejection.
      if (isOutOfSpanNumericId(target)) {
        return undefined;
      }

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
        // profile (the prefetch gate treats unknown as "don't spend").
        // Data-unavailability shapes (private/empty library — steamapi's
        // own TypeError on `games.map`; bogus/gone profile — Bad Request /
        // No players found / private game details) are routine and
        // user-triggerable: warn, not error, so they never read like an
        // outage in the ops log. Provider/rate-limit/genuine failures stay
        // loud.
        if (isBenignOwnedGamesError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            `getPlayerProfile: owned-games enrichment unavailable for steamId=${steamId} (private library or unresolvable profile):`,
            error instanceof Error ? error.message : error,
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(
            `getPlayerProfile: getUserOwnedGames failed to enrich isCSActive for steamId=${steamId}`,
            error,
          );
        }
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
        // The analytics payload (recordAnalytics) recomputes the flag from
        // the snapshot — without it a direct /player/[steamId] load
        // (seeded path, which skips /api/getUserInfo) always records
        // isCSActive=false and the dashboard CS Active counter freezes.
        plain.gamesSnapshot = gamesSnapshot;
      }

      return plain;
    } catch (error) {
      // Genuine failures (network, timeouts, dead key, bugs) must not
      // vanish: this seed path is SSR-critical and the catch below is the
      // only place they surface. Client-input shapes stay silent — they
      // already have honest handling upstream (isValidTargetParam's 400 on
      // the API routes, not-found render here), and logging them would
      // reintroduce the exact typo-noise this file's guards were built to
      // kill. (Deliberate asymmetry with getUserInfo's loud resolve-format
      // branch: inherited, pre-existing, out of scope here.)
      if (
        !isSteamProfileNotFoundError(error) &&
        !isSteamResolveFormatError(error)
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `getPlayerProfile: failed to resolve profile for target ${target}:`,
          error,
        );
      }
      return undefined;
    }
  },
);

export default getPlayerProfile;

import { cache } from 'react';
import SteamAPI, { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';

const steam = new SteamAPI(getSteamApiKey() ?? '');

const getPlayerProfile = cache(
  async (target: string): Promise<UserSummary | undefined> => {
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
      const profile = await steam.getUserSummary(steamId);
      const resolved = Array.isArray(profile) ? profile[0] : profile;
      // Ensure a plain serializable object is returned to avoid passing class
      // instances from Server -> Client components (Next.js runtime error).
      // JSON round-trip strips prototypes/methods, leaving a plain object.
      return resolved ? JSON.parse(JSON.stringify(resolved)) : undefined;
    } catch {
      return undefined;
    }
  },
);

export default getPlayerProfile;

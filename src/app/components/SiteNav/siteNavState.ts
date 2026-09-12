import type { CookieStore } from 'iron-session';

import getSteamIdentity from '@/lib/getSteamIdentity';
import { resolveWatchSession } from '@/lib/watch/session';

export type SiteNavState =
  | { steamId: string; nickname: string; avatarUrl: string | null }
  | { steamId: null };

/**
 * Server-side identity resolution for the global navbar, isolated from
 * rendering so a failure can NEVER take down the page tree.
 *
 * Blast-radius contract (P1 hardening): SiteNav mounts in the ROOT layout,
 * so any throw here would 500 every route (there is no error.tsx — an
 * uncaught layout error is a full-app outage). Auth/avatar resolution is
 * auxiliary chrome, not the page: on ANY unexpected failure this logs
 * loudly server-side and degrades to the logged-out cluster instead of
 * crashing. Deliberate split — API routes still fail LOUD (401/500) for
 * the same conditions; only the global navbar degrades, because search
 * must survive a broken bell.
 *
 * Note this catches only the unexpected: resolveWatchSession itself never
 * rejects by contract (bad cookies resolve to 'error'/'unauthenticated',
 * which already render logged-out below), and getSteamIdentity never
 * rejects either. This is the last-resort net for programming errors and
 * transport surprises in global chrome.
 */
export const resolveSiteNavState = async (
  cookieStore: CookieStore,
): Promise<SiteNavState> => {
  try {
    const session = await resolveWatchSession(cookieStore);
    const steamId =
      session.status === 'authenticated' ? session.steamId : null;
    if (steamId === null) return { steamId: null };
    const identity = await getSteamIdentity(steamId);
    return {
      steamId,
      nickname: identity?.nickname ?? steamId,
      avatarUrl: identity?.avatarUrl ?? null,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[SiteNav] identity resolution failed, degrading to logged-out: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { steamId: null };
  }
};

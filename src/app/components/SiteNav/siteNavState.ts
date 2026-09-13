import type { CookieStore } from 'iron-session';

import getSteamIdentity from '@/lib/getSteamIdentity';
import { sanitizeError } from '@/lib/sanitizeError';
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
 *
 * Cost note (accepted): reading the session here opts the whole layout out
 * of static rendering — inherent to ANY session-aware navbar, not to the
 * Steam call. The Steam round-trip itself is bounded instead: per-instance
 * 10-min TTL memo (nulls included, so outages stay cheap), 4s timeout, and
 * only for logged-in navigations. Client polls on top are equally bounded:
 * WatchManager mounts (and polls) only while the avatar dropdown is open,
 * and WatchInbox never intervals — fetch on mount/open/retry only.
 */
export const resolveSiteNavState = async (
  cookieStore: CookieStore,
): Promise<SiteNavState> => {
  try {
    const session = await resolveWatchSession(cookieStore);
    if (session.status === 'error') {
      // 'error' is NOT a normal logged-out state — the session layer
      // caught something unexpected (e.g. a broken SESSION_SECRET that
      // fails every seal/unseal). Still degrade (never 500 the layout),
      // but leave a trace: without this a sick config reads as "nobody
      // is logged in" with zero server-side signal.
      // eslint-disable-next-line no-console
      console.error(
        `[SiteNav] session resolution errored, degrading to logged-out: ${sanitizeError(session.error)}`,
      );
      return { steamId: null };
    }
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
      `[SiteNav] identity resolution failed, degrading to logged-out: ${sanitizeError(error)}`,
    );
    return { steamId: null };
  }
};

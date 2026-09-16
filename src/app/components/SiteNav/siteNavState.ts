import type { CookieStore } from 'iron-session';

import { getAccount, getWatchStatus } from '@/lib/analytics/db';
import type {
  WatchAccount,
  WatchStatus,
} from '@/lib/analytics/types';
import getSteamIdentity from '@/lib/getSteamIdentity';
import { sanitizeError } from '@/lib/sanitizeError';
import { resolveConfirmLinkState } from '@/lib/watch/confirmLinkState';
import type { WarmWatchStatusSnapshot } from '@/app/templates/Home/hooks/watch/watchStatusPrefetch';
import { resolveWatchSession } from '@/lib/watch/session';

export type SiteNavState =
  | {
      steamId: string;
      nickname: string;
      avatarUrl: string | null;
      initialWatch: WarmWatchStatusSnapshot | null;
    }
  | { steamId: null };

/**
 * Mirrors the watch/status poll source of truth for the navbar seed: the
 * rule itself lives in @/lib/watch/confirmLinkState (shared, not copied),
 * this only adds the status field. Importing the route module instead
 * would share its module-scoped rate limiter with the layout and drag
 * route-handler code into the page tree. (The route additionally skips
 * the account read unless pending — same result under the app's
 * invariants, since a confirmed account always resolves {false, false};
 * just one fewer query on the hot poll path.)
 */
const toInitialWatchSnapshot = (
  status: WatchStatus | null,
  account: WatchAccount | null,
): WarmWatchStatusSnapshot => ({
  status: status ?? 'none',
  ...resolveConfirmLinkState(account),
});

/**
 * Watch seed for the avatar dropdown's first paint (SSR-seed): two
 * indexed PK reads. ISOLATED try/catch on purpose — a DB blip must
 * degrade to a cold open (initialWatch: null → skeleton path), never to
 * logged-out: the outer catch in resolveSiteNavState below maps ANY throw
 * to `{ steamId: null }`.
 */
const readWatchSeed = async (
  steamId: string,
): Promise<WarmWatchStatusSnapshot | null> => {
  try {
    const [watchStatus, account] = await Promise.all([
      getWatchStatus(steamId),
      getAccount(steamId),
    ]);
    return toInitialWatchSnapshot(watchStatus, account);
  } catch (error) {
    // Missing DATABASE_URL (plain local dev without analytics) is an
    // expected config state, not an incident — stay quiet then. Real
    // failures (present env, dead transport) log loudly like everything
    // else in global chrome.
    if (process.env.DATABASE_URL) {
      // eslint-disable-next-line no-console
      console.error(
        `[SiteNav] watch seed read failed, opening cold: ${sanitizeError(error)}`,
      );
    }
    return null;
  }
};

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
 * only for logged-in navigations. The watch seed adds two indexed PK reads
 * (watch status + account, one parallel round) for the same audience —
 * same fail-open contract, and children keep streaming inside Suspense
 * regardless. Deliberately NO memo on the seed (unlike the identity memo):
 * a cached pending→active flip would stale the dropdown's first paint for
 * the TTL window, while two PK reads per logged-in SSR nav stay cheap at
 * any traffic this layout serves — revisit only with measured p99 pain.
 * Client polls on top are equally bounded:
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
    // Identity (Steam network round-trip, the long pole) and the watch
    // seed (two indexed PK reads) are independent given the steamId — run
    // them together so the cluster waits on the slower lane only, never
    // on the sum. readWatchSeed never rejects (DB blip → null seed), and
    // getSteamIdentity never rejects either, so a failure on either side
    // lands in the outer catch below exactly as before (logged-out).
    const [identity, initialWatch] = await Promise.all([
      getSteamIdentity(steamId),
      readWatchSeed(steamId),
    ]);
    return {
      steamId,
      nickname: identity?.nickname ?? steamId,
      avatarUrl: identity?.avatarUrl ?? null,
      initialWatch,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[SiteNav] identity resolution failed, degrading to logged-out: ${sanitizeError(error)}`,
    );
    return { steamId: null };
  }
};

import getAnalyticsSkipHeaders from '@/lib/analytics/skipHeaders';
import {
  LOGIN_FUNNEL_CTX_COOKIE,
  LOGIN_FUNNEL_CTX_MAX_AGE_SECONDS,
  type LoginCtx,
} from '@/lib/analytics/loginFunnelCookie';

export type { LoginCtx };

/**
 * Steam-login funnel instrumentation, client side (the shared cookie
 * contract the server reads back lives in
 * `@/lib/analytics/loginFunnelCookie` — this file never defines wire
 * shapes the backend depends on).
 *
 * Funnel join key: an anonymous per-browser UUID (`sr_anon_sid`,
 * localStorage — persistent, so it survives the Steam OpenID round-trip
 * in the same browser) mirrored, on CTA click only, into a short-lived
 * readable cookie (`sr_login_ctx`, 40min) carrying the active searchId.
 * The OAuth callback/pending completion reads the cookie server-side and
 * records `login_completed` against the same session id — no auth-flow
 * changes, no URL params, no PII (never a Steam ID).
 *
 * The cookie NAME, lifetime and parsing live in
 * `@/lib/analytics/loginFunnelCookie` (leaf module, no deps) so server
 * code can share the contract without importing this UI-side file. This
 * module keeps only what is genuinely client-only (storage, document,
 * fetch) plus the module-scoped active-search store.
 *
 * Everything here is best-effort and never throws into the caller: the
 * browser ALWAYS produces a session id (localStorage, or an ephemeral
 * fallback when storage is blocked — the ctx cookie carries it through
 * the OAuth round-trip), and a missing ctx cookie on the completion side
 * simply records NULLs (volume counts, excluded from the per-session
 * conversion rate).
 */

export {
  LOGIN_FUNNEL_CTX_COOKIE,
  LOGIN_FUNNEL_CTX_MAX_AGE_SECONDS,
} from '@/lib/analytics/loginFunnelCookie';

const ANON_SESSION_STORAGE_KEY = 'sr_anon_sid';

const newAnonSessionId = (): string => {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `anon-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
};

/**
 * Stable anonymous session id for this browser. Created once, reused for
 * every funnel event — this is what makes the CTA→completion join
 * per-user instead of aggregate-only. When localStorage is unavailable
 * (privacy mode, blocked storage) it degrades to an EPHEMERAL per-
 * page-load id: the beacon needs a string the parser accepts (a NULL sid
 * is a 400), and the ctx cookie carries the same id to the server-side
 * completion — so the funnel still pairs for THAT login, it just doesn't
 * survive a page reload (the best a storage-less browser can offer).
 * Null only outside the browser (SSR — callers there never fire the CTA).
 */
let ephemeralSessionId: string | null = null;

export const getOrCreateAnonSessionId = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const existing = window.localStorage.getItem(ANON_SESSION_STORAGE_KEY);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const fresh = newAnonSessionId();
    window.localStorage.setItem(ANON_SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    if (ephemeralSessionId === null) {
      ephemeralSessionId = newAnonSessionId();
    }
    return ephemeralSessionId;
  }
};

// Active search correlation for the CTA click. The navbar lives outside
// the search context (subscribing it would re-render global chrome on
// every search — the Data/Actions split exists to prevent exactly that),
// so useHomeSearch mirrors its searchId STATE into this store through a
// single effect (one sync point — future reset/set sites can't forget it)
// and the sign-in pill reads it on click. Null outside a search / after
// reset.
let activeLoginSearchId: string | null = null;

export const setActiveLoginSearchId = (searchId: string | null): void => {
  activeLoginSearchId = searchId;
};

export const getActiveLoginSearchId = (): string | null =>
  activeLoginSearchId;

/**
 * Plants the funnel ctx cookie for the login round-trip. No-op
 * server-side. Overwrites on every CTA click (re-login after logout
 * re-correlates cleanly); the 40min expiry (see loginFunnelCookie — covers
 * the 30min pending-login window plus OAuth margin) bounds staleness
 * without an explicit clear on the callback side.
 */
export const writeLoginCtxCookie = (ctx: LoginCtx): void => {
  if (typeof document === 'undefined') return;
  try {
    const value = encodeURIComponent(
      JSON.stringify({ sid: ctx.sessionId, searchId: ctx.searchId }),
    );
    const secure =
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie =
      `${LOGIN_FUNNEL_CTX_COOKIE}=${value}; Max-Age=${LOGIN_FUNNEL_CTX_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Best effort: a failed cookie write only loses correlation.
  }
};

/**
 * Fire-and-forget CTA beacon (navbar sign-in onClick). Never throws, never
 * blocks navigation — the caller must NOT await it.
 */
export const recordLoginCta = async (): Promise<void> => {
  try {
    if (typeof fetch !== 'function') return;
    const sessionId = getOrCreateAnonSessionId();
    const searchId = getActiveLoginSearchId();
    writeLoginCtxCookie({ sessionId, searchId });
    await fetch('/api/recordAnalyticsLogin', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...getAnalyticsSkipHeaders(),
      },
      body: JSON.stringify({
        event: 'login_cta_clicked',
        sessionId,
        searchId,
      }),
    });
  } catch {
    // Best effort: analytics must never break or delay the login.
  }
};

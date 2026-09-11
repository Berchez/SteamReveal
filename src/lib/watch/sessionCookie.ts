/**
 * Watch session cookie contract (Steam OpenID login) — leaf module with NO
 * runtime dependencies on purpose.
 *
 * `session.ts` imports iron-session (ESM-only), which cannot be statically
 * imported from Playwright specs. The e2e suite needs exactly two things
 * from the session layer — the cookie NAME and the payload SHAPE — so they
 * live here, importable from anywhere (app, bot-adjacent code, specs).
 */

export const WATCH_SESSION_COOKIE = 'steamreveal_watch_session';

/**
 * One-shot login-CSRF nonce cookie (see the login/callback routes).
 * Short-lived (minutes), cleared on every callback hit — success or fail.
 */
export const WATCH_OAUTH_STATE_COOKIE = 'steamreveal_oauth_state';

/** Sealed payload: the verified SteamID64 plus an absolute expiry. */
export interface WatchSessionData {
  steamId: string;
  expiresAt: number;
}

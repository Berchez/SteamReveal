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

/**
 * Sealed payload: the verified SteamID64 plus an absolute expiry, tagged
 * with the cookie's kind (symmetric with PendingLoginData's tag — the two
 * cookies share SESSION_SECRET, so each validator refuses the other's
 * tag). Optional (not required) on purpose: sessions sealed before any
 * tag existed must keep validating, or every deploy would mass-logout
 * the 30-day base. The validator denylists known-foreign tags instead.
 */
export interface WatchSessionData {
  kind?: 'watch-session';
  steamId: string;
  expiresAt: number;
}

/**
 * Short-lived pending-login cookie (login-first flow): sealed right after
 * a successful OpenID assertion for a NOT-YET-friend, holding the verified
 * identity until the waiting room observes the bot friendship and
 * completes the login. Same seal as the session (iron-session +
 * SESSION_SECRET), much shorter life — see pendingLogin.ts.
 */
export const PENDING_LOGIN_COOKIE = 'steamreveal_pending_login';

/**
 * Pending-login payload: the OpenID-verified SteamID64, the validated
 * post-login destination (re-validated at completion — defense in depth),
 * and an absolute expiry. Carries NO privilege by itself: completion
 * re-proves the friendship server-side before sealing anything.
 *
 * The explicit `kind` tag is defense in depth against cross-cookie replay:
 * both cookies share SESSION_SECRET with near-identical shapes, so a
 * discriminator the validator REQUIRES (not merely carries) makes a
 * pending value structurally unsealable as a session even if the lib ever
 * stopped binding ciphertext to the cookie name. (The session side is
 * deliberately untouched: requiring a tag there would mass-logout every
 * sealed 30-day session on deploy.)
 */
export interface PendingLoginData {
  kind: 'pending-login';
  steamId: string;
  next: string;
  expiresAt: number;
}

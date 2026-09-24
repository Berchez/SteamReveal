/**
 * Login-funnel cookie contract (Steam sign-in instrumentation) — leaf
 * module with NO runtime dependencies on purpose.
 *
 * The funnel spans two layers: client code (the navbar CTA beacon, which
 * WRITES this cookie) and server code (completeProvenLogin, which READS it
 * back after the OAuth round-trip). Both sides must agree on the name,
 * shape and lifetime, so they live here — importable from anywhere without
 * dragging UI code into server libs or vice versa (see the layering note
 * in completeLogin.ts).
 */

export const LOGIN_FUNNEL_CTX_COOKIE = 'sr_login_ctx';

/**
 * Ctx cookie lifetime: must cover the WHOLE login, not just the OAuth
 * dance. The waiting room holds a pending login for PENDING_LOGIN_TTL
 * (30min — the user leaves, finds the bot on Steam, adds it, comes back),
 * and that 30min starts at the callback, MINUTES after the CTA click that
 * plants this cookie. 40min = 30min pending + generous OAuth margin; any
 * lower and high-friction logins (exactly what the funnel measures) would
 * expire mid-wait and convert to NULL-session completions — dropping
 * conversions from the numerator and biasing the rate DOWNWARD against
 * the slowest users, i.e. undercounting the very friction the funnel
 * exists to quantify. Deliberately a literal, not
 * an import of PENDING_LOGIN_TTL_SECONDS: that lives under lib/watch
 * next to ESM-only iron-session, which must never leak into the client
 * bundle through this leaf.
 */
export const LOGIN_FUNNEL_CTX_MAX_AGE_SECONDS = 40 * 60;

export type LoginCtx = {
  sessionId: string | null;
  searchId: string | null;
};

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64;

/**
 * Parses a raw `sr_login_ctx` cookie value. Defensive by design (client-
 * writable cookies are untrusted input): anything misshapen degrades to
 * NULLs, never throws. decodeURIComponent is applied because WE encode on
 * write (cookie values can't carry raw {}""); if a transport ever hands
 * us an already-decoded value it's a no-op for our ids (UUIDs and
 * server-generated search ids contain no %), and a hostile %-trick only
 * corrupts the attacker's OWN funnel row — never another user's.
 */
export const parseLoginCtx = (value: unknown): LoginCtx => {
  const fallback: LoginCtx = { sessionId: null, searchId: null };
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      sessionId: validId(record.sid) ? record.sid : null,
      searchId: validId(record.searchId) ? record.searchId : null,
    };
  } catch {
    return fallback;
  }
};

/**
 * Reads the funnel ctx through an iron-session CookieStore (what the auth
 * routes pass around). Tolerates both `{ value }` and raw-string shapes;
 * never throws — a missing/unreadable cookie is a NULL-ctx completion.
 */
export const readLoginCtxFromStore = (store: unknown): LoginCtx => {
  const fallback: LoginCtx = { sessionId: null, searchId: null };
  try {
    if (typeof store !== 'object' || store === null) return fallback;
    const getter = (store as Record<string, unknown>).get;
    if (typeof getter !== 'function') return fallback;
    const raw = (
      getter as (name: string) => { value?: unknown } | string | undefined
    ).call(store, LOGIN_FUNNEL_CTX_COOKIE);
    if (typeof raw === 'string') return parseLoginCtx(raw);
    if (typeof raw === 'object' && raw !== null) {
      return parseLoginCtx((raw as { value?: unknown }).value);
    }
    return fallback;
  } catch {
    return fallback;
  }
};

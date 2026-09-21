/**
 * Steam OpenID 2.0 (login) — pure fetch, no new dependencies.
 *
 * Flow: login route 302s the browser to the endpoint below (checkid_setup
 * with identifier_select); Steam authenticates the user and GETs our
 * callback with a signed assertion; the callback POSTs the assertion back
 * with mode=check_authentication (direct verification) and trusts the
 * claimed_id ONLY when the endpoint answers `is_valid:true`.
 *
 * Never trust `openid.claimed_id` (or any assertion field) before that
 * verification — it arrives via the user's browser and is forgeable.
 */

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

/**
 * Internal-redirect guard for the auth flow (`next` param + callback
 * target). Explicit allowlist (never a blocklist): single-slash paths of
 * unreserved/punctuation characters only. This rejects absolute URLs,
 * protocol-relative `//evil`, backslashes, whitespace/control bytes
 * (header splitting, parser differentials) and `#`/`@`/`:` (fragment /
 * userinfo / scheme confusion) by construction rather than one by one.
 * Belt over suspenders: every redirect is additionally built as
 * `${origin}${next}` by string concatenation, never `new URL(next, base)`,
 * so a hostile `next` could never become a host even if this check were
 * bypassed.
 */
export const isSafeNextPath = (value: unknown): value is string =>
  typeof value === 'string' && /^\/(?!\/)[\w\-./~%?&=]*$/.test(value);

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const OPENID_IDENTIFIER_SELECT =
  'http://specs.openid.net/auth/2.0/identifier_select';

const CLAIMED_ID_RE =
  /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Freshness window for `openid.response_nonce` (login-replay defense in
 * depth). The single-use `state` cookie already binds each callback URL to
 * the browser that started the login (replay elsewhere fails closed), and
 * a spec-compliant OP invalidates nonces after first use — this check
 * covers the residual case (stale captured URL + OP that never expires
 * nonces) by rejecting assertions older than the window, without any
 * server-side nonce store to operate. Generous on purpose: Steam and our
 * clock may skew by minutes; beyond the window the user just logs in
 * again (safe retry, no lockout).
 */
export const RESPONSE_NONCE_MAX_AGE_MS = 10 * 60 * 1000;

export const isFreshResponseNonce = (
  nonce: unknown,
  nowMs: number = Date.now(),
): boolean => {
  if (typeof nonce !== 'string') return false;
  // Leading UTC timestamp, with or without fractional seconds (Steam sends
  // none; JS ISOs have them) — anything else is malformed on sight.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(nonce);
  if (match === null) return false;
  const issuedMs = Date.parse(match[1]);
  if (!Number.isFinite(issuedMs)) return false;
  const ageMs = nowMs - issuedMs;
  // Future-dated (clock skew the other way) counts as fresh only within
  // the same tolerance — never accept a nonce from far ahead.
  return ageMs >= -RESPONSE_NONCE_MAX_AGE_MS && ageMs <= RESPONSE_NONCE_MAX_AGE_MS;
};

export interface SteamLoginUrlOptions {
  /** Absolute callback URL Steam returns the user to. */
  returnTo: string;
  /** Site root (scheme + host); must match return_to's origin. */
  realm: string;
}

/** Authorization URL the login route redirects to. Never throws. */
export const buildSteamLoginUrl = ({
  returnTo,
  realm,
}: SteamLoginUrlOptions): string => {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': OPENID_IDENTIFIER_SELECT,
    'openid.claimed_id': OPENID_IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
};

/** SteamID64 from a verified claimed_id, or null for anything else. */
export const extractSteamIdFromClaimedId = (
  claimedId: unknown,
): string | null => {
  if (typeof claimedId !== 'string') return null;
  const match = CLAIMED_ID_RE.exec(claimedId.trim());
  return match ? match[1] : null;
};

/**
 * Direct-verification of a callback assertion: replays the received
 * openid.* params with mode=check_authentication and returns the verified
 * SteamID64 — or null when Steam says is_valid:false, the claimed_id is
 * malformed, or the assertion is incomplete. Rejects on transport failure
 * (callers log and redirect to the error state).
 */
export const verifySteamAssertion = async (
  received: Record<string, string>,
  endpoint: string = STEAM_OPENID_ENDPOINT,
): Promise<string | null> => {
  const body = new URLSearchParams();
  Object.keys(received).forEach((key) => {
    if (key.startsWith('openid.')) body.append(key, received[key]);
  });
  body.set('openid.mode', 'check_authentication');
  // Fail fast without contacting Steam: unsigned assertions and
  // non-Steam/non-shape claimed_ids are forgeable on sight. The freshness
  // gate runs here too (not after verification): a stale assertion is
  // rejected before spending a network roundtrip on it.
  if (!body.has('openid.sig')) return null;
  if (extractSteamIdFromClaimedId(received['openid.claimed_id']) === null) {
    return null;
  }
  if (!isFreshResponseNonce(received['openid.response_nonce'])) return null;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(
      `Steam OpenID verification unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const text = await res.text();
  if (!/^is_valid:true\s*$/m.test(text)) return null;
  return extractSteamIdFromClaimedId(received['openid.claimed_id']);
};

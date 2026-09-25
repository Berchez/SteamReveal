/**
 * SteamID64 shape check — single source of truth shared by the watch API
 * routes, the session layer, and the watch frontend. Do NOT fork this
 * regex per call site: a drift silently accepts in one layer what another
 * rejects.
 *
 * Deliberately shape-only (17 digits, NO 7656119... prefix requirement).
 * Individual universe-1 accounts span 76561197960… through 76561202255…
 * (accountid fills 32 bits), so a prefix check would reject legitimate
 * future accounts — the length check is the stable contract.
 */
export const STEAM_ID64_RE = /^\d{17}$/;

export const isSteamId64 = (value: unknown): value is string =>
  typeof value === 'string' && STEAM_ID64_RE.test(value);

/**
 * The mathematically valid span of universe-1 INDIVIDUAL-account
 * SteamID64s: 76561197960265728 + accountId, accountId ∈ [0, 2^32-1] →
 * [76561197960265728, 76561202255233023]. Every present and future
 * individual account lands inside it (this is a RANGE check, not the
 * prefix check deliberately rejected above — high accountids are
 * accepted), so a 17-digit number outside it can never be a real
 * profile: it's a typo/garbage the Steam API would only answer with
 * "Bad Request"/"No players found". BigInt() call form (not literals —
 * the tsconfig target predates ES2020 literal syntax) with string args so
 * the comparison stays exact past Number.MAX_SAFE_INTEGER. Use at the
 * ENTRY-VALIDATION layer (isValidTargetParam, getPlayerProfile guard) —
 * not to tighten the session layer, whose ids are OpenID-verified already.
 */
const STEAM_ID64_MIN = BigInt('76561197960265728');
const STEAM_ID64_MAX = BigInt('76561202255233023');

export const isPlausibleSteamId64 = (value: unknown): value is string =>
  isSteamId64(value) &&
  BigInt(value) >= STEAM_ID64_MIN &&
  BigInt(value) <= STEAM_ID64_MAX;

/**
 * A 17-digit string that falls OUTSIDE the valid SteamID64 span: it can
 * never be a real profile, so entry layers reject it before any Steam
 * call (isValidTargetParam → 400; getPlayerProfile → undefined). Single
 * source for the shape+range rule — both call sites must keep using THIS,
 * never a hand-rolled `/^\d{17}$/` + range pair that can drift apart.
 */
export const isOutOfSpanNumericId = (value: unknown): value is string =>
  isSteamId64(value) && !isPlausibleSteamId64(value);

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

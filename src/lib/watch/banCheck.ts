/**
 * Ban Reveal Steam ban check (Phase 1, source = 'steam' only).
 *
 * Quota discipline is the primary risk of this feature: product search AND
 * the watch lanes already share STEAM_API_KEY / STEAM_API_KEY_2 (see
 * getSteamApiKey.ts). This sweep reads from an OPTIONAL dedicated key
 * (STEAM_BAN_CHECK_API_KEY) so quota isolation is possible without being
 * mandatory on day one — when unset, it falls back to the shared pool.
 * Never log any key, not even partially.
 */

import SteamAPI from 'steamapi';

import getSteamApiKey from '../getSteamApiKey';
import withTimeout from '../withTimeout';

/** Dedicated sweep key when set, otherwise the shared product/watch pool. */
export const getBanCheckApiKey = (): string | undefined =>
  process.env.STEAM_BAN_CHECK_API_KEY || getSteamApiKey();

// Module-scoped instances are the repo convention for SteamAPI, but a plain
// module-level `new SteamAPI()` would read the env at import time — before
// the bot's loadEnv() populates a local .env (imports hoist above it), so a
// local-only STEAM_BAN_CHECK_API_KEY would be missed. Lazy singleton
// instead: one live instance per key in practice, env always read fresh
// (key rotation converges on next call), never constructed per request.
let cachedSteam: { key: string | undefined; steam: SteamAPI } | null = null;

const getSteam = (): SteamAPI => {
  const key = getBanCheckApiKey();
  if (!cachedSteam || cachedSteam.key !== key) {
    cachedSteam = { key, steam: new SteamAPI(key ?? '') };
  }
  return cachedSteam.steam;
};

export interface BanVerdictRow {
  steamID?: unknown;
  vacBans?: unknown;
  gameBans?: unknown;
}

/**
 * Pure ban-verdict parser, shared by the single-target check below and the
 * sweep's batched caller (bot-steam/index.ts) — one definition, so the two
 * paths cannot drift apart. Field names pinned against the installed
 * steamapi UserBans structure (vacBans/gameBans numbers, steamID string):
 * the bannedFriendsMethod lane already relies on the same names in
 * production, and the fixtures below lock them in.
 *
 * Scope is VAC + game bans ONLY, deliberately: this is the cheater context
 * (a reviewer suspected cheating), so community/economy bans (moderation,
 * fraud — a different product question) do not count.
 *
 * Absent fields are UNKNOWN (null), never clean: if a future lib/API
 * drift drops these keys, the target must degrade to "skip this pass",
 * not to a false clean persisted in the sweep baseline. Only an explicit
 * numeric zero counts as clean. (Present-but-null counts as absent —
 * Steam sometimes nulls unknown fields instead of omitting them.)
 *
 * Returns true = banned, false = clean, null = unknown/malformed (never
 * guess: null is fail-open upstream — no alert, sweep heals next pass).
 */
export const parseBanVerdict = (ban: unknown): boolean | null => {
  if (!ban || typeof ban !== 'object') return null;
  const row = ban as BanVerdictRow;
  // Present-but-null counts as absent (Steam sometimes nulls unknown
  // fields instead of omitting them).
  if (row.vacBans == null || row.gameBans == null) return null;
  const vacBans = Number(row.vacBans);
  const gameBans = Number(row.gameBans);
  if (!Number.isFinite(vacBans) || !Number.isFinite(gameBans)) return null;
  return vacBans > 0 || gameBans > 0;
};

/**
 * Single-target ban verdict via GetPlayerBans (VAC or game ban — the Phase 1
 * scope). Returns true when banned, false when clean, null when the check
 * itself failed (Steam down, malformed response, timeout): callers treat
 * null as "unknown" (fail-open, never an alert — the sweep heals on the
 * next pass). Never throws.
 */
export const isSteamTargetBanned = async (
  targetSteamId: string,
  timeoutMs = 8000,
): Promise<boolean | null> => {
  try {
    const bansInfo = await withTimeout(
      getSteam().getUserBans([targetSteamId]),
      `banCheck: getUserBans(${targetSteamId})`,
      timeoutMs,
    );
    const ban = Array.isArray(bansInfo) ? bansInfo[0] : bansInfo;
    return parseBanVerdict(ban);
  } catch {
    return null;
  }
};

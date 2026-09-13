import { isSteamId64 } from './steamId';

/**
 * Shared GetPlayerSummaries fetch (single Steam endpoint both Watch
 * consumers need). Deliberately dependency-free (no react/cache, no
 * alias imports) so the ts-node bot can import it exactly like Next
 * does — always via a RELATIVE path (see the no-restricted-imports
 * override for src/bot-steam/**).
 *
 * Thin by design: fetch + shape-check, nothing else. Caching, timeouts,
 * mock fixtures, and field mapping stay with the callers
 * (getSteamIdentity: avatar + TTL memo; resolveNotifyDisplayName:
 * nickname + sanitizing) — those policies differ and must not couple.
 * Never throws: any failure (bad id, network, non-ok, empty players)
 * resolves to null and the caller degrades.
 */
export interface SteamPlayerSummary {
  personaname?: unknown;
  avatarmedium?: unknown;
}

export const fetchPlayerSummary = async (
  steamId: string,
  apiKey: string,
): Promise<SteamPlayerSummary | null> => {
  if (!isSteamId64(steamId) || apiKey === '') return null;
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`,
      // Next-only option, ignored by Node: the bot must never serve a
      // cached CDN/proxy response for identity data either way.
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      response?: { players?: SteamPlayerSummary[] };
    };
    return body?.response?.players?.[0] ?? null;
  } catch {
    return null;
  }
};

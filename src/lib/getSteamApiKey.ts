/**
 * Shared Steam Web API key pool: product search AND the watch lanes
 * (login friendship checks, waiting-room re-proofs, navbar identity,
 * bot notify nicknames) all draw from these same keys, with random
 * two-key failover when both are set. A login/onboarding spike therefore
 * spends the search product's quota too — accepted for now because every
 * watch read is memoized or tiered (identity 10-min TTL, pending-room
 * 10s→30s backoff tiers), and steady-state watch traffic is ~zero
 * outside active onboardings. Explicit scaling plan: if Steam p99
 * degrades under login spikes, split a dedicated key for the watch
 * lanes (new env + a getWatchSteamApiKey) instead of adding a third key
 * to this pool — sharing dilutes per-key headroom silently, a separate
 * pool fails (and alarms) independently.
 */
function getSteamApiKey() {
  const key1 = process.env.STEAM_API_KEY;
  const key2 = process.env.STEAM_API_KEY_2;

  if (key1 && key2) {
    return Math.random() < 0.5 ? key1 : key2;
  }

  return key1 || key2;
}

export default getSteamApiKey;

/**
 * True when a steamapi failure means "this profile does not exist" — the
 * lib throws the literal Error('No players found') when GetPlayerSummaries
 * answers 200 with an empty `players` array (a valid-looking id Steam has
 * no record of). That is client input (typo, stale link, deleted account),
 * not a server failure, so callers map it to 400, not 500 — and stay
 * unlogged like the other invalid-target 400s.
 *
 * Same coupling warning as isBenignOwnedGamesError: this matches on the
 * lib's thrown message string, which steamapi does not expose as a code.
 * Re-validate on ANY steamapi bump or removal (see
 * patches/steamapi+3.0.8.patch) — a renamed message would silently turn
 * these 400s back into 500s.
 */
export default function isSteamProfileNotFoundError(
  error: unknown,
): boolean {
  return (
    error instanceof Error && /no players found/i.test(error.message)
  );
}

/**
 * True when a steamapi owned-games failure is a DATA-UNAVAILABILITY
 * condition (the profile's privacy settings, or a profile Steam simply
 * has no data for) rather than a server failure:
 * - "Unauthorized"/"Forbidden" — game details set to private (Steam
 *   answers 401/403 when hours visibility is off; the library is intact,
 *   just not exposed to our key — the same privacy axis as a private
 *   friends list, not an outage);
 * - "Bad Request" — an id Steam won't accept (bogus/gone profile);
 * - "No players found" — profile doesn't exist;
 * - TypeError on 'map' — steamapi's own shape bug for private/EMPTY
 *   libraries: GetOwnedGames answers 200 with no `games` key and the lib
 *   crashes on `response.games.map(...)` (its source, not ours, unfixed
 *   upstream). Matched on the QUOTED 'map' only — both V8 phrasings cite
 *   it as "reading 'map'" / "property 'map'", while an unquoted
 *   "x.map is not a function" would be OUR bug and must stay loud.
 *
 * Callers downgrade these to warn so a private library never reads like
 * an outage in the error logs; everything else (network, 429, timeouts,
 * genuine bugs) stays a loud error.
 *
 * Why "Unauthorized"/"Forbidden" can't mask a dead API key into a SILENT
 * success: a broken key fails EVERY Steam call with the same strings, and
 * every call site above pairs owned-games with a sibling call on that
 * same key whose failure path this PR does not touch — getUserInfo and
 * the cheater route 500 loudly, getPlayerProfile renders its not-found
 * state (and now logs genuine failures — see its catch). The benign
 * bucket only ever quiets the owned-games DUPLICATE; it cannot turn a key
 * outage into a successful response. (No metrics infra exists to count
 * warn spikes — the warn lines stay greppable via "owned-games" +
 * "unavailable", the repo's monitoring model.)
 *
 * Sibling-verified call sites ONLY: gameLibraryStatsMethod has no local
 * sibling (its only Steam call is owned-games), so it must NOT use this
 * classifier — it uses isPrivateLibraryShapeError below instead, which a
 * dead key provably cannot produce (a dead key yields HTTP 401, never a
 * 200 with a missing `games` key).
 *
 * FRAGILE BY CONSTRUCTION: this matches on steamapi's thrown message
 * strings ("Bad Request", "No players found", the TypeError wording),
 * which the package does not expose as codes — a steamapi version bump
 * can silently rename them and flip real incidents into the benign
 * bucket (or vice versa) with no compile error. Re-validate these
 * strings (and isBenignOwnedGamesError.test.ts) on ANY steamapi bump or
 * removal — see patches/steamapi+3.0.8.patch if the lib is touched.
 */
/**
 * The unambiguous subset of the benign shapes above: steamapi's own
 * TypeError on a QUOTED 'map' (private/empty library answering 200 with
 * no `games` key — both V8 phrasings). Unlike the string shapes, this one
 * is PROVABLY unreachable from a dead API key (which yields HTTP 401,
 * never a 200), so call sites WITHOUT a local sibling verification
 * (gameLibraryStatsMethod) gate on this alone and keep everything else
 * loud. Same FRAGILE note as above re: steamapi bumps.
 */
export function isPrivateLibraryShapeError(error: unknown): boolean {
  return error instanceof TypeError && /['"]map['"]/.test(error.message);
}

export default function isBenignOwnedGamesError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return isPrivateLibraryShapeError(error);
  }
  return (
    error instanceof Error &&
    /unauthorized|forbidden|bad request|no players found/i.test(
      error.message,
    )
  );
}

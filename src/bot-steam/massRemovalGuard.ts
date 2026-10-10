/**
 * Mass-removal circuit breaker — pure verdict shared by the reconcile
 * removal branches (watches AND the orphan-account sweep): a
 * wrong/empty/partial friendsList snapshot makes every missing row read
 * as opted-out, silently killing state until each user re-adds. The
 * CANDIDATES are therefore computed BEFORE any write, and only removal
 * branches are gated (activations and confirm links proceed normally).
 * (Search-history links are NOT at stake in removals — unfriend
 * preserves them by product decision; only the explicit Clear and the
 * TTL purge cut links.)
 * A lone candidate always flows (one removal is not mass — the common
 * single opt-out must never stall behind an override). Past that, an
 * empty snapshot or candidates past max(20, 10% of the base) skip
 * removals for the pass with an ERROR log (`massRemovalAborted` in the
 * report); everything else converges. A genuinely confirmed
 * mass-removal goes through the explicit `massRemoveMax` option
 * (BotConfig `reconcileMassRemoveMax`, env RECONCILE_MASS_REMOVE_MAX=N),
 * never silently — set it only for the confirmed window, then unset
 * and restart (see the runbook bot-swap procedure).
 *
 * Floor, not pure percentage: on a tiny base (5 watches) even one
 * genuine unfriend is 20% — the percentage arm only bites once the base
 * is large enough that a glitch can hide inside it.
 *
 * Override shape (deliberately numeric, not boolean): massRemoveMax is
 * the max removals a pass will perform while set. A forgotten boolean
 * stays off-guard forever; a forgotten NUMBER still caps the blast
 * radius at N. Set it comfortably ABOVE the expected genuine count for
 * the window (swap with base 200 → 250, the bot caps at ~250 friends),
 * then unset and restart.
 */

import { isSteamId64 } from '../lib/steamId';

const MASS_REMOVE_FLOOR = 20;
const MASS_REMOVE_FRACTION = 0.1;

export interface MassRemovalVerdict {
  /** Whether removals must be skipped this pass. */
  blocked: boolean;
  /** Rows missing from the snapshot (valid ids only). */
  candidates: string[];
  /** The size-derived ceiling (before any numeric override). */
  ceiling: number;
}

/**
 * Override normalization, shared by the guard and the log line below:
 * a finite positive number floors to itself, anything else (null,
 * undefined, NaN, zero/negative) means "no override". One definition
 * so the two can never disagree on whether an override is set.
 */
export const normalizeMassRemoveMax = (
  massRemoveMax: number | null | undefined,
): number | null =>
  typeof massRemoveMax === 'number' &&
  Number.isFinite(massRemoveMax) &&
  massRemoveMax > 0
    ? Math.floor(massRemoveMax)
    : null;

/**
 * Pure mass-removal verdict (no I/O, no logging — trivially
 * table-testable): given the listed rows and the snapshot's friend
 * set, decide whether the removal branch may run. Callers log and gate
 * on `blocked`.
 *
 * Singles always flow: one removal is by definition not mass, and
 * blocking it strands genuine single opt-outs — the common churn,
 * e.g. the last friend leaving a tiny base — behind an override no
 * operator can distinguish from a glitch. Blast radius of a wrong
 * single: one user, and even singles leave an info audit line per
 * removal (only the ERROR escalation is skipped).
 */
export const evaluateMassRemovalGuard = (
  watches: Array<{ steamId: string; status: string }>,
  friends: ReadonlySet<string>,
  massRemoveMax?: number | null,
  swapMode?: boolean,
): MassRemovalVerdict => {
  const candidates = watches
    .filter(
      (watch) =>
        isSteamId64(watch.steamId) &&
        watch.status === 'active' &&
        !friends.has(watch.steamId),
    )
    .map((watch) => watch.steamId);
  const ceiling = Math.max(
    MASS_REMOVE_FLOOR,
    Math.ceil(watches.length * MASS_REMOVE_FRACTION),
  );
  // Numeric override (not boolean): N or fewer removals always flow,
  // anything past max(ceiling, N) still trips — EXCEPT the
  // empty-snapshot arm, which a bare number can never waive (below). A
  // forgotten N therefore degrades to a bounded ceiling, never to
  // guard-off. (Bounded by the FRIEND CAP in practice: the bot cannot
  // hold more than ~250 friends, so candidates past a sane N are either
  // a swap window or a glitch — both operator-attended states.)
  const override = normalizeMassRemoveMax(massRemoveMax);
  // The empty-snapshot arm is NEVER waived by the bare override: an
  // empty friendsList with candidates present means the fetch failed,
  // and a forgotten N ≥ base size (e.g. 500 on a ≤250 base) would
  // otherwise switch the guard off entirely with zero log output. Only
  // swapMode (explicit, time-boxed, separately warned per pass) waives
  // it — and only up to N.
  const emptyWaived =
    swapMode === true &&
    override !== null &&
    candidates.length <= override;
  const blocked =
    candidates.length > 1 &&
    !emptyWaived &&
    (friends.size === 0 ||
      candidates.length > Math.max(ceiling, override ?? 0));
  return { blocked, candidates, ceiling };
};

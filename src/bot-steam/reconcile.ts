/**
 * Watch Bot friends reconciliation (WB-4) — snapshot-driven, idempotent.
 *
 * Compares the bot's CURRENT friendsList snapshot (authoritative Steam
 * state, available on boot AND every reconnect) against the watches in the
 * DAL and converges them:
 *   - pending + friend + confirmed (or legacy row with no account at all,
 *     which consented under the old friendship-activates contract)
 *     -> activateWatch() (+ onActivated welcome)
 *   - pending + friend + unconfirmed -> onConfirmLinkNeeded() (confirm
 *     link ONLY — click-to-activate: friendship alone never activates,
 *     so the watch cannot notify or toast before the link click)
 *   - active + SteamID is NOT a friend -> removeWatchAndAccount()
 *   - everything else                   -> untouched
 *
 * This is snapshot-driven (not polled): callers feed it the friendsList
 * snapshot on boot, reconnect, and live accept events (bot.ts forwards
 * Friend transitions with the accepted id merged in, because the library
 * emits before updating its own map). Removals have a dedicated live
 * listener instead (Epic 6, friendRemoved.ts) — reconcile is their offline
 * backstop, sharing the same deactivateWatch call.
 * Re-running with no changes is a verified no-op (idempotency is
 * unit-tested, not just claimed).
 *
 * Passes are SERIALIZED across callers (promise chain below): snapshots
 * arrive both on full syncs and on individual accepts, so two passes can
 * overlap in time — and overlapping passes both read pre-commit state,
 * which would fire onActivated (welcome message) twice for the same
 * profile. The DB update dedupes concurrent flips (rowsAffected > 0 wins
 * exactly once — activateWatch returns true ONLY to the flipper), but
 * chaining additionally keeps every pass reading post-commit state, so
 * the loser skips the branch entirely instead of merely losing the race
 * (fewer redundant account reads, deterministic row order and error
 * attribution).
 * Skipping (drop-if-busy) would be wrong here, unlike the poller: a
 * dropped accept snapshot might never reconcile (no further event may
 * come), so every snapshot waits its turn instead.
 *
 * The optional onActivated hook fires once per newly-activated watch with
 * its stored locale (WB-11 welcome message). It runs AFTER activateWatch
 * commits, and its failures are isolated per row without rolling the
 * activation back.
 *
 * SteamIDs arrive as strings (object keys of myFriends). Anything that is
 * not a 17-digit id is skipped and counted, never passed to the DAL.
 *
 * Mass-removal circuit breaker (one docblock below, above the
 * constants — the header only points here, details live in exactly one
 * place).
 */

import type { RemoveWatchResult } from '../lib/analytics/db';
import type { WatchAccount } from '../lib/analytics/types';
import { isSteamId64 } from '../lib/steamId';
import type { WatchBotLogger } from './logger';

/**
 * Mass-removal circuit breaker — single docblock (the header above only
 * points here): a wrong/empty/partial friendsList snapshot makes every
 * active watch read as opted-out — and since the history purge rides on
 * removeWatchAndAccount, one bad snapshot would ALSO wipe search
 * histories irreversibly. The removal CANDIDATES are therefore computed
 * BEFORE any write, and only the REMOVAL branch is gated: activations
 * and confirm links proceed normally (activating requires
 * friends.has(), so a partial snapshot cannot falsely activate — it can
 * only falsely remove). A lone candidate always flows (one removal is
 * not mass — the common single opt-out must never stall behind an
 * override). Past that, an empty snapshot or candidates past max(20,
 * 10% of the base) skip removals for the pass with an ERROR log
 * (`massRemovalAborted` in the report); everything else converges. A genuinely confirmed mass-removal goes
 * through the explicit `massRemoveMax` option (BotConfig
 * `reconcileMassRemoveMax`, env RECONCILE_MASS_REMOVE_MAX=N), never
 * silently — set it only for the confirmed window, then unset and
 * restart (see the runbook bot-swap procedure).
 *
 * Floor, not pure percentage: on a tiny base (5 watches) even one
 * genuine unfriend is 20% — the percentage arm only bites once the base
 * is large enough that a glitch can hide inside it.
 *
 * Override shape (deliberately numeric, not boolean): massRemoveMax is
 * the max removals a pass will perform while set. A forgotten boolean
 * stays off-guard forever; a forgotten NUMBER still caps the blast
 * radius at N. Set it comfortably ABOVE the expected genuine count for
 * the window (swap with base 300 → 500), then unset and restart.
 */
const MASS_REMOVE_FLOOR = 20;
const MASS_REMOVE_FRACTION = 0.1;

export interface MassRemovalVerdict {
  /** Whether removals must be skipped this pass. */
  blocked: boolean;
  /** Active watches missing from the snapshot (valid ids only). */
  candidates: string[];
  /** The size-derived ceiling (before any numeric override). */
  ceiling: number;
}

/**
 * Pure mass-removal verdict (no I/O, no logging — trivially
 * table-testable): given the listed watches and the snapshot's friend
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

export interface ReconcileDal {
  listWatchedProfiles: () => Promise<
    Array<{ steamId: string; status: string; locale: string | null }>
  >;
  activateWatch: (steamId: string) => Promise<boolean>;
  removeWatchAndAccount: (steamId: string) => Promise<RemoveWatchResult>;
  /**
   * Watch-only removal (leaves the accounts row AND the search-history
   * links intact). Used ONLY in swap mode (see ReconcileOptions): a
   * bot-swap must reset watches without destroying accounts/history.
   */
  deactivateWatch: (steamId: string) => Promise<boolean>;
  /** Confirmation read for the click-to-activate branch below. */
  getAccount: (steamId: string) => Promise<WatchAccount | null>;
}

export interface ReconcileReport {
  friends: number;
  watches: number;
  activated: string[];
  deactivated: string[];
  /** Profiles that actually got a confirm link this pass (sent, not skipped). */
  confirmLinksSent: string[];
  skippedInvalidIds: number;
  errors: Array<{ steamId: string; operation: string; message: string }>;
  durationMs: number;
  /**
   * True when the mass-removal breaker tripped: REMOVALS were blocked
   * this pass (activations and confirm links still converged). Until the
   * snapshot looks sane again — or the operator override lands — every
   * pass reports this instead of removing. The next pass retries
   * normally; fix the snapshot, not the flag.
   */
  massRemovalAborted: boolean;
}

/**
 * Fired once per newly-activated watch, AFTER activateWatch resolves.
 * The host uses it for post-activation side effects that need a live
 * Steam session (WB-11: the welcome chat message). Failures are isolated
 * per row into errors[] with operation 'welcomeMessage' — the activation
 * itself already committed and is never rolled back for a send failure.
 */
export type ActivatedHandler = (profile: {
  steamId: string;
  locale: string | null;
}) => Promise<void> | void;

/**
 * Fired once per pending+friend watch whose account is still unconfirmed.
 * The implementor delivers the confirm link WITHOUT activating (see
 * sendConfirmLink): activation happens exactly once, later, in the
 * confirm route's POST after the click. Return true when a link actually
 * went out (counted in report.confirmLinksSent); false/void when skipped
 * (live token outstanding, raced confirmation — steady-state, not an
 * error). Throwing is isolated per row into errors[] with operation
 * 'confirmLink'. Optional (tests, minimal wirings): without it an
 * unconfirmed watch simply stays pending.
 */
export type ConfirmLinkHandler = (profile: {
  steamId: string;
  locale: string | null;
}) => Promise<boolean> | boolean;

/**
 * Pass-scoped knobs. All optional so existing callers keep working with
 * positional args alone.
 */
export interface ReconcileOptions {
  /**
   * Operator-confirmed mass-removal ceiling (BotConfig
   * reconcileMassRemoveMax, env RECONCILE_MASS_REMOVE_MAX=N): passes
   * perform up to N removals (bot-swap window with a known-good but
   * empty friends list). Never silent — set only for the confirmed
   * window, then unset and restart. Null/undefined (default) means no
   * override: the breaker guards every pass.
   */
  massRemoveMax?: number | null;
  /**
   * Bot-swap mode for THIS pass (the host computes it per pass from
   * BotConfig reconcileSwapUntilMs, one-shot — never read env here):
   * removals delete ONLY the watched_profiles row (deactivateWatch),
   * preserving the accounts row and the search-history links. Genuine
   * unfriends (live path, normal reconcile) NEVER use this — opt-out
   * means both rows go.
   */
  swapMode?: boolean;
}

/**
 * Swap-window check (pure, tested): the window is a timestamp, not a
 * boolean, so a forgotten override expires by itself instead of leaving
 * preservation on forever (preservation-forever would silently stop
 * purging genuine leavers' histories — the exact inversion the boolean
 * was criticized for).
 */
export const isSwapWindowActive = (
  nowMs: number,
  swapUntilMs: number | null | undefined,
): boolean =>
  typeof swapUntilMs === 'number' &&
  Number.isFinite(swapUntilMs) &&
  nowMs < swapUntilMs;

/**
 * One-shot swap-exemption bookkeeping (pure, tested).
 *
 * Two halves, intentionally split across the serialized chain (see the
 * host): REQUEST (`requestSwapExemption`) runs at call time, CONSUME
 * happens only for a pass that actually ran in swap mode cleanly
 * (resolved, breaker silent, no row errors). A failed pass
 * (rejection), a blocked pass, or a pass with row errors leaves it
 * armed, so the backlog is never stranded behind a consumed flag.
 */
export const requestSwapExemption = (
  windowActive: boolean,
  consumed: boolean,
): boolean => windowActive && !consumed;

/**
 * Post-pass verdict for an armed exemption (pure, tested): keep it
 * consumed only when the armed pass ran cleanly (resolved, breaker
 * silent, zero row errors). Anything else rolls back to armed so the
 * next pass retries with swap semantics.
 */
export const shouldKeepSwapExemption = (report: {
  massRemovalAborted: boolean;
  errors: Array<unknown>;
}): boolean => !report.massRemovalAborted && report.errors.length === 0;

const runReconcilePass = async (
  friendsById: Record<string, number>,
  friendRelationshipValue: number,
  dal: ReconcileDal,
  logger: WatchBotLogger = console,
  onActivated: ActivatedHandler | undefined = undefined,
  onConfirmLinkNeeded: ConfirmLinkHandler | undefined = undefined,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> => {
  const startedAt = Date.now();
  const report: ReconcileReport = {
    friends: 0,
    watches: 0,
    activated: [],
    deactivated: [],
    confirmLinksSent: [],
    skippedInvalidIds: 0,
    errors: [],
    durationMs: 0,
    massRemovalAborted: false,
  };

  const friends = new Set<string>();
  Object.entries(friendsById).forEach(([id, relationship]) => {
    // Single source of truth (src/lib/steamId.ts) — never fork the shape
    // per call site, per that module's contract.
    if (!isSteamId64(id)) {
      report.skippedInvalidIds += 1;
    } else if (relationship === friendRelationshipValue) {
      friends.add(id);
    }
  });
  report.friends = friends.size;

  const watches = await dal.listWatchedProfiles();
  report.watches = watches.length;

  // Mass-removal breaker: compute the verdict BEFORE any write (pure
  // helper above — the case table is unit-tested directly). Only the
  // REMOVAL branch is gated — activations and confirm links proceed
  // (activating requires friends.has(), so a corrupt snapshot cannot
  // falsely activate, only falsely remove). Gated-out removals are
  // retried by the next pass from scratch.
  const {
    blocked: removalsBlocked,
    candidates: removalCandidates,
    ceiling: removalCeiling,
  } = evaluateMassRemovalGuard(
    watches,
    friends,
    options.massRemoveMax,
    options.swapMode,
  );
  const normalizedOverride = normalizeMassRemoveMax(options.massRemoveMax);
  const overrideNote =
    normalizedOverride === null ? '' : ` overrideMax=${normalizedOverride}`;
  if (removalsBlocked) {
    report.massRemovalAborted = true;
    logger.error(
      `[WatchBot] reconcile removals BLOCKED (mass-removal guard): friends=${report.friends} watches=${report.watches} ` +
        `removalCandidates=${removalCandidates.length} ceiling=${removalCeiling}${overrideNote}. ` +
        `Snapshot looks wrong/partial — removals skipped, everything else converges. ` +
        `Set RECONCILE_MASS_REMOVE_MAX above the expected genuine count only for an operator-confirmed window.`,
    );
  }

  // for..of (not .forEach/.map): per-row awaits must run SEQUENTIALLY, and
  // an async forEach would fire them all concurrently as floating promises.
  // eslint-disable-next-line no-restricted-syntax
  for (const watch of watches) {
    if (!isSteamId64(watch.steamId)) {
      report.skippedInvalidIds += 1;
    } else {
      try {
        // Sequential awaits are intentional (same precedent as
        // scripts/migrate-db.ts): rows converge in a deterministic order,
        // one isolated try/catch per row, and no write burst against Turso.
        if (watch.status === 'pending' && friends.has(watch.steamId)) {
          // Click-to-activate: friendship alone no longer activates. The
          // account read decides the lane — confirmed (or legacy rows
          // without an account row, which consented under the old
          // contract) take the activate path; unconfirmed accounts get
          // the confirm link instead and stay pending until the click.
          // A read failure skips the row this pass (recorded below,
          // retried next pass — same contract as the outer catch).
          let account: WatchAccount | null | undefined;
          try {
            // eslint-disable-next-line no-await-in-loop
            account = await dal.getAccount(watch.steamId);
          } catch (error) {
            report.errors.push({
              steamId: watch.steamId,
              operation: 'confirmLink',
              message:
                error instanceof Error ? error.message : String(error),
            });
          }
          if (account !== undefined) {
            if (account === null || account.confirmedAt !== null) {
              // eslint-disable-next-line no-await-in-loop
              const activated = await dal.activateWatch(watch.steamId);
              if (activated) {
                report.activated.push(watch.steamId);
                if (onActivated) {
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    await onActivated({
                      steamId: watch.steamId,
                      locale: watch.locale ?? null,
                    });
                  } catch (error) {
                    // Labeled for the actual sender (confirm link OR welcome —
                    // see handleActivation), not a blanket 'welcomeMessage'.
                    report.errors.push({
                      steamId: watch.steamId,
                      operation: 'activationMessage',
                      message:
                        error instanceof Error ? error.message : String(error),
                    });
                  }
                }
              }
            } else if (onConfirmLinkNeeded !== undefined) {
              try {
                // eslint-disable-next-line no-await-in-loop
                const sent = await onConfirmLinkNeeded({
                  steamId: watch.steamId,
                  locale: watch.locale ?? null,
                });
                if (sent) report.confirmLinksSent.push(watch.steamId);
              } catch (error) {
                report.errors.push({
                  steamId: watch.steamId,
                  operation: 'confirmLink',
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
            // No link hook configured: unconfirmed stays pending silently.
          }
        } else if (
          watch.status === 'active' &&
          !friends.has(watch.steamId) &&
          !removalsBlocked
        ) {
          // Opt-out while offline: the SAME composite the live
          // friend-remove path uses (one transaction — both rows go or
          // neither does, so no user record survives an unfriend and the
          // next signup re-confirms). Skipped wholesale while the breaker
          // holds (logged once above, retried next pass). A failure is
          // labeled with the single operation name; the row stays listed
          // and the next pass retries.
          //
          // Swap mode (runbook §7) takes the OTHER lane: deactivateWatch
          // drops only the watch row, preserving the accounts row and the
          // search-history links. A bot-swap is involuntary for users —
          // their histories (and their attribution, which keys on
          // accounts) survive it; only genuine unfriends take the
          // full-removal lane above.
          try {
            let watchDeleted: boolean;
            if (options.swapMode === true) {
              // eslint-disable-next-line no-await-in-loop
              watchDeleted = await dal.deactivateWatch(watch.steamId);
            } else {
              // eslint-disable-next-line no-await-in-loop
              watchDeleted = (await dal.removeWatchAndAccount(watch.steamId))
                .watchDeleted;
            }
            if (watchDeleted) {
              report.deactivated.push(watch.steamId);
              // Per-removal audit line (irreversible deletion — the
              // summary counts alone don't say WHO was removed, and
              // post-mortems always ask exactly that).
              logger.info(
                `[WatchBot] reconcile deactivated watch (opt-out): steamId=${watch.steamId} swapMode=${options.swapMode === true}`,
              );
            }
          } catch (error) {
            report.errors.push({
              steamId: watch.steamId,
              operation: 'removeWatch',
              message:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        // One bad row must not abort the whole pass: record it and keep
        // converging everything else. The next run retries it.
        report.errors.push({
          steamId: watch.steamId,
          operation:
            watch.status === 'pending' ? 'activateWatch' : 'deactivateWatch',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  report.durationMs = Date.now() - startedAt;
  logger.info(
    `[WatchBot] reconcile done: friends=${report.friends} watches=${report.watches} ` +
      `activated=${report.activated.length} deactivated=${report.deactivated.length} ` +
      `linksSent=${report.confirmLinksSent.length} ` +
      `skippedInvalidIds=${report.skippedInvalidIds} errors=${report.errors.length} ` +
      `removalsBlocked=${report.massRemovalAborted} ` +
      `durationMs=${report.durationMs}`,
  );
  if (report.errors.length > 0) {
    logger.error(
      `[WatchBot] reconcile errors: ${JSON.stringify(report.errors)}`,
    );
  }

  return report;
};

// Serial pass chain (see the header doc): every call waits for the
// previous pass to settle, then runs against post-commit state. A rejected
// pass must not poison the chain — the tail swallows the rejection (the
// caller still receives it via their own promise).
let reconcileTail: Promise<void> = Promise.resolve();

export const reconcileFriendsList = (
  friendsById: Record<string, number>,
  friendRelationshipValue: number,
  dal: ReconcileDal,
  logger: WatchBotLogger = console,
  onActivated: ActivatedHandler | undefined = undefined,
  onConfirmLinkNeeded: ConfirmLinkHandler | undefined = undefined,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> => {
  const run = reconcileTail.then(() =>
    runReconcilePass(
      friendsById,
      friendRelationshipValue,
      dal,
      logger,
      onActivated,
      onConfirmLinkNeeded,
      options,
    ),
  );
  reconcileTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

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
 * KNOWN LIMITATION (pre-prod ticket, not handled here): there is no
 * circuit breaker on mass removal. A wrong/empty/partial friendsList
 * snapshot (beyond the wrong-account case, which fail-fasts in bot.ts)
 * makes every active watch read as opted-out and DELETES the base
 * irreversibly (removeWatchAndAccount drops both rows). The intended
 * guard: compute the removal set first and abort the pass with an ERROR
 * log when friends.size === 0 with watches present, or removals exceed
 * max(20, 10% of the base), behind an explicit override
 * (RECONCILE_ALLOW_MASS_REMOVE=1). Until that exists, treat any
 * unexpected mass-deactivation as a stop-the-line incident, not noise.
 */

import type { RemoveWatchResult } from '../lib/analytics/db';
import type { WatchAccount } from '../lib/analytics/types';
import { isSteamId64 } from '../lib/steamId';
import type { WatchBotLogger } from './logger';

export interface ReconcileDal {
  listWatchedProfiles: () => Promise<
    Array<{ steamId: string; status: string; locale: string | null }>
  >;
  activateWatch: (steamId: string) => Promise<boolean>;
  removeWatchAndAccount: (steamId: string) => Promise<RemoveWatchResult>;
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

const runReconcilePass = async (
  friendsById: Record<string, number>,
  friendRelationshipValue: number,
  dal: ReconcileDal,
  logger: WatchBotLogger = console,
  onActivated: ActivatedHandler | undefined = undefined,
  onConfirmLinkNeeded: ConfirmLinkHandler | undefined = undefined,
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
        } else if (watch.status === 'active' && !friends.has(watch.steamId)) {
          // Opt-out while offline: the SAME composite the live
          // friend-remove path uses (one transaction — both rows go or
          // neither does, so no user record survives an unfriend and the
          // next signup re-confirms). A failure is labeled with the single
          // operation name; the row stays listed and the next pass retries.
          try {
            // eslint-disable-next-line no-await-in-loop
            const { watchDeleted } = await dal.removeWatchAndAccount(watch.steamId);
            if (watchDeleted) {
              report.deactivated.push(watch.steamId);
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
): Promise<ReconcileReport> => {
  const run = reconcileTail.then(() =>
    runReconcilePass(
      friendsById,
      friendRelationshipValue,
      dal,
      logger,
      onActivated,
      onConfirmLinkNeeded,
    ),
  );
  reconcileTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

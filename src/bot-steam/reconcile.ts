/**
 * Watch Bot friends reconciliation (WB-4) — snapshot-driven, idempotent.
 *
 * Compares the bot's CURRENT friendsList snapshot (authoritative Steam
 * state, available on boot AND every reconnect) against the watches in the
 * DAL and converges them:
 *   - pending + SteamID is a friend  -> activateWatch()
 *   - active + SteamID is NOT a friend -> deactivateWatch()
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
 * The optional onActivated hook fires once per newly-activated watch with
 * its stored locale (WB-11 welcome message). It runs AFTER activateWatch
 * commits, and its failures are isolated per row without rolling the
 * activation back.
 *
 * SteamIDs arrive as strings (object keys of myFriends). Anything that is
 * not a 17-digit id is skipped and counted, never passed to the DAL.
 */

export interface ReconcileDal {
  listWatchedProfiles: () => Promise<
    Array<{ steamId: string; status: string; locale: string | null }>
  >;
  activateWatch: (steamId: string) => Promise<boolean>;
  deactivateWatch: (steamId: string) => Promise<boolean>;
}

export interface ReconcileLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface ReconcileReport {
  friends: number;
  watches: number;
  activated: string[];
  deactivated: string[];
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

const STEAM_ID64_RE = /^\d{17}$/;

export const reconcileFriendsList = async (
  friendsById: Record<string, number>,
  friendRelationshipValue: number,
  dal: ReconcileDal,
  logger: ReconcileLogger = console,
  onActivated: ActivatedHandler | undefined = undefined,
): Promise<ReconcileReport> => {
  const startedAt = Date.now();
  const report: ReconcileReport = {
    friends: 0,
    watches: 0,
    activated: [],
    deactivated: [],
    skippedInvalidIds: 0,
    errors: [],
    durationMs: 0,
  };

  const friends = new Set<string>();
  Object.entries(friendsById).forEach(([id, relationship]) => {
    if (!STEAM_ID64_RE.test(id)) {
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
    if (!STEAM_ID64_RE.test(watch.steamId)) {
      report.skippedInvalidIds += 1;
    } else {
      try {
        // Sequential awaits are intentional (same precedent as
        // scripts/migrate-db.ts): rows converge in a deterministic order,
        // one isolated try/catch per row, and no write burst against Turso.
        if (watch.status === 'pending' && friends.has(watch.steamId)) {
          // eslint-disable-next-line no-await-in-loop
          await dal.activateWatch(watch.steamId);
          report.activated.push(watch.steamId);
          if (onActivated) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await onActivated({
                steamId: watch.steamId,
                locale: watch.locale ?? null,
              });
            } catch (error) {
              report.errors.push({
                steamId: watch.steamId,
                operation: 'welcomeMessage',
                message:
                  error instanceof Error ? error.message : String(error),
              });
            }
          }
        } else if (watch.status === 'active' && !friends.has(watch.steamId)) {
          // eslint-disable-next-line no-await-in-loop
          await dal.deactivateWatch(watch.steamId);
          report.deactivated.push(watch.steamId);
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

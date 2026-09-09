/**
 * Watch Bot friend-removal handler (WB-8) — the official opt-out path.
 *
 * When a user unfriends (or blocks) the bot, bot.ts extracts the affected
 * steamId from the `friendRelationship` event and calls this. It deactivates
 * the watch through the existing DAL (`deactivateWatch`, shared with the
 * WB-4 reconciliation — no duplicated deactivation logic anywhere) and logs
 * the outcome structurally.
 *
 * Design notes:
 * - Idempotent by construction: an already-removed watch resolves to
 *   "already inactive" (info, not error), so duplicate events are safe.
 * - Never throws for operational failures (DAL errors are caught, logged,
 *   and reported in the result) — an exception here must not take down the
 *   bot's event loop.
 * - No secrets ever flow through this module (only the public steamId), so
 *   there is nothing sensitive to leak into logs by construction.
 */

export interface FriendRemovedDal {
  deactivateWatch: (steamId: string) => Promise<boolean>;
}

export interface FriendRemovedLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface FriendRemovedResult {
  steamId: string;
  deactivated: boolean;
}

const STEAM_ID64_RE = /^\d{17}$/;

export const handleFriendRemoved = async (
  steamId: string,
  dal: FriendRemovedDal,
  logger: FriendRemovedLogger = console,
): Promise<FriendRemovedResult> => {
  if (!STEAM_ID64_RE.test(steamId)) {
    logger.error(
      `[WatchBot] friend-remove ignored: malformed steamId ${JSON.stringify(steamId)}`,
    );
    return { steamId, deactivated: false };
  }

  try {
    const deactivated = await dal.deactivateWatch(steamId);
    if (deactivated) {
      logger.info(
        `[WatchBot] friend-remove: watch deactivated steamId=${steamId} event=friend-remove result=deactivated`,
      );
    } else {
      logger.info(
        `[WatchBot] friend-remove: no active watch steamId=${steamId} event=friend-remove result=already-inactive`,
      );
    }
    return { steamId, deactivated };
  } catch (error) {
    logger.error(
      `[WatchBot] friend-remove failed: steamId=${steamId} event=friend-remove error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { steamId, deactivated: false };
  }
};

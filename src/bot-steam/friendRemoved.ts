/**
 * Watch Bot friend-removal handler (WB-8) — the official opt-out path.
 *
 * When a user unfriends (or blocks) the bot, bot.ts extracts the affected
 * steamId from the `friendRelationship` event and calls this. It deactivates
 * the watch through the existing DAL (`deactivateWatch`, shared with the
 * WB-4 reconciliation — no duplicated deactivation logic anywhere) and logs
 * the outcome structurally.
 *
 * A None event can also mean a sent invite that was cancelled/expired
 * server-side while the watch was still pending (never a genuine
 * unfriend). Deleting that row is still correct: with no friendship and
 * no tracked invite it could never activate, and keeping it would block
 * re-request for 7 days — deletion lets the user re-request a fresh
 * invite immediately.
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

import { isSteamId64 } from '@/lib/steamId';

import type { WatchBotLogger } from './logger';

export interface FriendRemovedDal {
  deactivateWatch: (steamId: string) => Promise<boolean>;
}

export interface FriendRemovedResult {
  steamId: string;
  deactivated: boolean;
}

export const handleFriendRemoved = async (
  steamId: string,
  dal: FriendRemovedDal,
  logger: WatchBotLogger = console,
): Promise<FriendRemovedResult> => {
  if (!isSteamId64(steamId)) {
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

/**
 * Watch Bot friend-removal handler (WB-8) — the official opt-out path.
 *
 * When a user unfriends (or blocks) the bot, bot.ts extracts the affected
 * steamId from the `friendRelationship` event and calls this. It removes
 * the watch AND the signup account through the shared DAL composite
 * (`removeWatchAndAccount` — one transaction, same call the offline
 * reconcile pass uses, so the rule can never drift) and logs the outcome
 * structurally. Opt-out leaves no user record: a future re-signup starts
 * unconfirmed and gets a fresh confirm link, never silently skipping
 * confirmation on stale state.
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
 * - Truthful reporting: the composite is atomic (both rows go or neither
 *   does), so a failure genuinely means {false, false} — never one half
 *   masked as the other. The handler still never throws (an exception
 *   here must not take down the bot's event loop).
 * - No secrets ever flow through this module (only the public steamId), so
 *   there is nothing sensitive to leak into logs by construction.
 */

import type { RemoveWatchResult } from '../lib/analytics/db';
import { isSteamId64 } from '../lib/steamId';

import type { WatchBotLogger } from './logger';

export interface FriendRemovedDal {
  removeWatchAndAccount: (steamId: string) => Promise<RemoveWatchResult>;
}

export interface FriendRemovedResult {
  steamId: string;
  deactivated: boolean;
  accountDeleted: boolean;
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
    return { steamId, deactivated: false, accountDeleted: false };
  }

  try {
    const { watchDeleted, accountDeleted } =
      await dal.removeWatchAndAccount(steamId);
    if (watchDeleted) {
      logger.info(
        `[WatchBot] friend-remove: watch deactivated steamId=${steamId} event=friend-remove result=deactivated accountDeleted=${accountDeleted}`,
      );
    } else {
      logger.info(
        `[WatchBot] friend-remove: no active watch steamId=${steamId} event=friend-remove result=already-inactive accountDeleted=${accountDeleted}`,
      );
    }
    return { steamId, deactivated: watchDeleted, accountDeleted };
  } catch (error) {
    logger.error(
      `[WatchBot] friend-remove failed: steamId=${steamId} event=friend-remove operation=removeWatch error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { steamId, deactivated: false, accountDeleted: false };
  }
};

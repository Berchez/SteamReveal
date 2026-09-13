/**
 * Watch Bot activation message (navbar-global signup flow) — the one chat
 * line sent right after a watch flips pending -> active, split by
 * confirmation state:
 * - Unconfirmed account: issue a FRESH token (single writer — the signup
 *   route deliberately never issues) and send the confirm link.
 * - Confirmed account, or legacy row without an account: the classic
 *   welcome text.
 *
 * No retry/outbox here, CONSCIOUSLY (not an omission): the invite/notify
 * lanes need the outbox because a lost invite/notify is a lost user
 * action. A lost activation line degrades to legacy behavior — nothing
 * gates on confirmed_at, so the watch still notifies; the user just never
 * clicked a link. Failures stay loud (reconcile records them per row in
 * report.errors + logger), and recovery is manual but complete: unfriend
 * -> Start again -> a NEW activation re-issues a fresh token (old links
 * die on re-issue) and resends the link.
 *
 * Race note: issueConfirmToken returning false after we just read an
 * unconfirmed account means the user confirmed concurrently (clicked the
 * previous link mid-flight) — sending the fresh link would deliver a
 * dead token, so fall back to welcome instead.
 */

import { generateHexToken } from '../lib/watch/tokens';
import {
  getAccount,
  hashConfirmToken,
  issueConfirmToken,
} from '../lib/analytics/db';
import type { BotConfig } from './config';
import {
  sendConfirmMessage,
  type NotifyChatClient,
} from './notifyMessage';
import {
  sendWelcomeMessage,
  type WelcomeChatClient,
} from './welcomeMessage';

/**
 * Minimal structural surface of the Steam chat sender (steam-user's
 * chat.sendFriendMessage is promise-based in the installed v5 — verified
 * in components/chatroom.js — but absent from @types/steam-user, hence
 * this interface instead of the library type). Identical to the welcome
 * and notify client shapes by design: one sender, three message kinds.
 */
export type ActivationChatClient = WelcomeChatClient & NotifyChatClient;

export const handleActivation = async (
  chat: ActivationChatClient,
  steamId: string,
  locale: string | null,
  config: Pick<BotConfig, 'siteUrl' | 'confirmTokenTtlMs'>,
): Promise<void> => {
  const account = await getAccount(steamId);
  // Message language: the watch row's locale first (refreshed on every
  // expired re-request), falling back to the signup account's stored
  // locale (set once at signup) — so accounts.locale is a fallback, not
  // write-only. Templates fall back to English past both.
  const effectiveLocale = locale ?? account?.locale ?? null;
  if (account !== null && account.confirmedAt === null) {
    const token = generateHexToken();
    const issued = await issueConfirmToken(
      steamId,
      hashConfirmToken(token),
      new Date(Date.now() + config.confirmTokenTtlMs).toISOString(),
    );
    if (!issued) {
      // Confirmed concurrently between the read and the issue (see
      // above) — the fresh link would already be dead.
      await sendWelcomeMessage(chat, steamId, effectiveLocale);
      return;
    }
    await sendConfirmMessage(
      chat,
      steamId,
      effectiveLocale,
      `${config.siteUrl}/api/watch/confirm?token=${token}`,
    );
    return;
  }
  await sendWelcomeMessage(chat, steamId, effectiveLocale);
};

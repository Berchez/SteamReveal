/**
 * Watch Bot activation messaging (navbar-global signup flow) — the chat
 * lines around a watch flipping pending -> active, split by confirmation
 * state AND by caller:
 * - handleActivation (onActivated hook): runs AFTER activateWatch commits.
 *   Unconfirmed account: issue a FRESH token (single writer — the signup
 *   route deliberately never issues) and send the confirm link.
 *   Confirmed account, or legacy row without an account: the classic
 *   welcome text. Under click-to-activate the unconfirmed branch is a
 *   safety net (reconcile only activates confirmed/legacy rows), kept
 *   because a DAL bug must degrade to a link, never to silence.
 * - sendConfirmLink (confirm-link hook): runs for pending+friend watches
 *   whose account is still unconfirmed, WITHOUT activating — activation
 *   happens exactly once, later, in the confirm route's POST after the
 *   click. Issues ONLY when no token was ever issued (first contact);
 *   skips quietly otherwise — no row, already confirmed, or any previous
 *   generation dead or alive. In particular it NEVER re-issues over an
 *   expired token: expired generations belong to the expiry-notice +
 *   resend-request flow, and auto-reissuing here would silently resend on
 *   every reconcile pass, defeating both the single notice and the
 *   resend throttle.
 *
 * No retry/outbox here, CONSCIOUSLY (not an omission): the invite/notify
 * lanes need the outbox because a lost invite/notify is a lost user
 * action. A lost link line is recovered structurally — reconcile re-fires
 * the link hook every pass while unconfirmed (first issue only; later
 * passes are no-ops once a hash exists), the expiry poller notices dead
 * generations, and the resend flow delivers on demand. Failures stay loud
 * (reconcile records them per row in report.errors + logger).
 *
 * Race note: issueConfirmToken returning false after we just read an
 * unconfirmed account means the user confirmed concurrently (clicked the
 * previous link mid-flight) — sending the fresh link would deliver a
 * dead token, so fall back to welcome instead (handleActivation) or skip
 * quietly (sendConfirmLink — the confirm route owns activation + welcome
 * from there, and the watch is not active yet so a welcome would lie).
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

/**
 * Issues a fresh confirm token and delivers the confirm link WITHOUT
 * touching the watch status — the click-to-activate sender. Returns true
 * when a link actually went out (reconcile counts it), false for every
 * quiet skip. Throws on DAL/chat failures (caller isolates per row).
 *
 * Deliberate double-read note: callers (reconcile) already read the
 * account to route the lane, and this re-reads it anyway. That is the
 * freshness guarantee, not redundancy — a click landing between the
 * routing read and this one must be honored (skip), never overwritten
 * with a stale-state send.
 */
export const sendConfirmLink = async (
  chat: ActivationChatClient,
  steamId: string,
  locale: string | null,
  config: Pick<BotConfig, 'siteUrl' | 'confirmTokenTtlMs'>,
): Promise<boolean> => {
  const account = await getAccount(steamId);
  // No row (legacy watches predate accounts) or already confirmed: the
  // reconcile caller routes those to the legacy/activate lane instead, so
  // reaching here means a race — skip quietly, never mis-send.
  if (account === null || account.confirmedAt !== null) return false;
  // First issue ONLY: any stored token hash — live or long expired — means
  // a previous generation exists. A live one means an earlier pass already
  // delivered (or a resend is in flight); an expired one belongs to the
  // expiry-notice + resend-request flow from here on. Re-issuing over an
  // expired token here would silently auto-resend on every reconcile pass
  // (boot, reconnects, 10-min backstop), defeating both the single notice
  // and the resend poller's 1h throttle (which lives there, not here) —
  // and it would starve the expiry poller, which would never observe an
  // expired-unnoticed token again. (Normalized to null first: production
  // rows always carry the fields, but partial shapes must degrade to
  // "absent", never to "live". A hash with no expiry is hand-edit only,
  // since issue writes both — it also skips; fix by hand or re-signup.)
  const tokenHash = account.confirmTokenHash ?? null;
  if (tokenHash !== null) return false;
  const token = generateHexToken();
  const issued = await issueConfirmToken(
    steamId,
    hashConfirmToken(token),
    new Date(Date.now() + config.confirmTokenTtlMs).toISOString(),
  );
  if (!issued) {
    // Confirmed concurrently between the read and the issue (or the row
    // vanished) — the fresh link would already be dead, and the watch is
    // not active so a welcome would lie. The confirm route owns it now.
    return false;
  }
  await sendConfirmMessage(
    chat,
    steamId,
    locale ?? account.locale ?? null,
    `${config.siteUrl}/api/watch/confirm?token=${token}`,
  );
  return true;
};

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

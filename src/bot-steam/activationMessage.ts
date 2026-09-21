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
 *   click. Issues ONLY when no token was ever issued (first contact,
 *   guarded atomically in the UPDATE — a concurrent resend-lane issue
 *   wins instead of double-delivering);
 *   skips quietly otherwise — no row, already confirmed, or any previous
 *   generation dead or alive. In particular it NEVER re-issues over an
 *   expired token: expired generations belong to the expiry-notice +
 *   resend-request flow, and auto-reissuing here would silently resend on
 *   every reconcile pass, defeating both the single notice and the
 *   resend throttle.
 *
 * Delivery is NOT atomic with issuance, and the failure window is handled
 * EXPLICITLY (rollback, not outbox — see rollbackUndeliveredToken): a
 * chat send that fails AFTER issueConfirmToken commits would otherwise
 * strand the account for the token's whole TTL — the site's
 * confirmLinkSent derives from hash presence (UI: "check your Steam
 * chat") while every future pass skips on first-issue-only. The rollback
 * returns the account to "never issued", so recovery stays structural:
 * the next reconcile pass (≤10 min or the next reconnect) re-issues and
 * re-sends. The same "send failed → leave the row retryable" contract
 * covers the welcome path via the watch_events outbox
 * (sendWelcomeWithFallback), because an activated row never re-fires
 * hooks — a failed direct welcome would otherwise be lost forever.
 * Failures stay loud either way (reconcile records them per row in
 * report.errors + logger).
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
  clearConfirmToken,
  enqueueEvent,
  getAccount,
  hashConfirmToken,
  issueConfirmToken,
  issueConfirmTokenIfAbsent,
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

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Rolls back an issued-but-undelivered confirm token (compare-and-delete).
 * Returns void on success — the CALLER rethrows the original send error
 * (reconcile's per-row isolation and its tests key on the send failure
 * itself; the rollback is remediation, not the story). Only a rollback
 * that ITSELF fails throws here, chaining the original error as `cause`
 * so neither stack is lost: the row may then hold an undelivered hash
 * that nothing auto-retries (first-issue-only), which needs hand
 * attention or a user resend request.
 *
 * Ambiguity trade-off, stated plainly (same as the resend lane): a
 * timeout-style send failure may have delivered without answering, so
 * this rollback can invalidate a link the user already received — the
 * next pass then delivers a second, live one. Bounded at 2-3 messages
 * by the attempt caps, strictly better than the 24h lockout; a "got two
 * links" report traces back here. (This lane has no logger of its own —
 * the rethrown send error still lands in reconcile's per-row error log.)
 *
 * clearConfirmToken is a compare-and-delete: a concurrent click that
 * consumed the token, or a resend generation that replaced it, survives
 * untouched (a false return means a newer state won — nothing to clear).
 */
const rollbackUndeliveredToken = async (
  steamId: string,
  tokenHash: string,
  sendError: unknown,
): Promise<void> => {
  try {
    await clearConfirmToken(steamId, tokenHash);
  } catch (rollbackError) {
    throw new Error(
      `confirm-link send failed (${describeError(sendError)}) AND the token ` +
        `rollback failed (${describeError(rollbackError)}) — the account may ` +
        'hold an undelivered hash no pass will retry; clear it by hand or ' +
        'via a resend request',
      { cause: sendError },
    );
  }
};

/**
 * Welcome sender with an outbox fallback. The callers run AFTER
 * activateWatch committed (the row is active NOW), so NOTHING will ever
 * re-fire this hook — a failed direct send would lose the welcome
 * forever, silently. On a send failure the welcome is enqueued into
 * watch_events for the welcome poller (the same retry/drop lane the
 * click path uses, same message + watch locale) and the send error is
 * swallowed: delivery is the queue's job now. An enqueue failure still
 * propagates — reconcile isolates it per row, loudly. Double-delivery
 * risk on ambiguous send failures (timeout that actually delivered)
 * matches the accepted poller-lane semantics.
 */
const sendWelcomeWithFallback = async (
  chat: ActivationChatClient,
  steamId: string,
  locale: string | null,
): Promise<void> => {
  try {
    await sendWelcomeMessage(chat, steamId, locale);
  } catch {
    await enqueueEvent(steamId, 'welcome');
  }
};

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
  const issuedHash = hashConfirmToken(token);
  // Guarded (if-absent) issue, not the unconditional one: the resend lane
  // runs concurrently in this same process and issues unconditionally on
  // explicit user request — a blind issue here could double-deliver (two
  // links, first dead). The guard makes the explicit request win
  // deterministically; a 0-row loss means the resend owns delivery now.
  const issued = await issueConfirmTokenIfAbsent(
    steamId,
    issuedHash,
    new Date(Date.now() + config.confirmTokenTtlMs).toISOString(),
  );
  if (!issued) {
    // Lost a race: confirmed concurrently (or the row vanished) — the
    // fresh link would already be dead — or the resend lane issued first
    // (its delivery supersedes this one). Either way the watch is not
    // active so a welcome would lie. The confirm route owns it now.
    return false;
  }
  try {
    await sendConfirmMessage(
      chat,
      steamId,
      locale ?? account.locale ?? null,
      `${config.siteUrl}/api/watch/confirm?token=${token}`,
    );
  } catch (error) {
    // Delivery failed AFTER the issuance committed: roll the token back
    // (compare-and-delete) so the account returns to "never issued" and
    // the next reconcile pass re-issues + re-sends, then rethrow the
    // ORIGINAL error so the failure stays loud in the pass report.
    // Without the rollback the user would stare at "check your Steam
    // chat" (confirmLinkSent derives from hash presence) until the 24h
    // expiry — with no auto-retry (first-issue-only skips every later
    // pass) and no resend button before the expiry flips confirmExpired.
    await rollbackUndeliveredToken(steamId, issuedHash, error);
    throw error;
  }
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
    const tokenHash = hashConfirmToken(token);
    const issued = await issueConfirmToken(
      steamId,
      tokenHash,
      new Date(Date.now() + config.confirmTokenTtlMs).toISOString(),
    );
    if (!issued) {
      // Confirmed concurrently between the read and the issue (see
      // above) — the fresh link would already be dead.
      await sendWelcomeWithFallback(chat, steamId, effectiveLocale);
      return;
    }
    try {
      await sendConfirmMessage(
        chat,
        steamId,
        effectiveLocale,
        `${config.siteUrl}/api/watch/confirm?token=${token}`,
      );
    } catch (error) {
      // Same rollback as sendConfirmLink: the hash must not outlive an
      // undelivered link (this row is already active, so the resend flow
      // would be the only recovery left — and its throttle counts from
      // the issuance hour, not delivery). Rethrow the original after the
      // rollback so the failure stays loud.
      await rollbackUndeliveredToken(steamId, tokenHash, error);
      throw error;
    }
    return;
  }
  await sendWelcomeWithFallback(chat, steamId, effectiveLocale);
};

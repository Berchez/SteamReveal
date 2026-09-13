/**
 * Watch Bot notify message (WB-13) — sent over Steam chat for every consumed
 * `notify` event.
 *
 * Templates live in @/lib/watch/notificationText (WB-15 shared base, not
 * in next-intl messages/*.json): the bot process has no React/intl
 * provider, the site inbox renders the same base text for the same event,
 * and the language comes from the locale stored on watched_profiles, not
 * from any page locale. See the base module for the content contract.
 */
import { randomBytes } from 'crypto';

import {
  DEFAULT_WATCH_LOCALE,
  getConfirmText,
  getNotifyText,
} from '../lib/watch/notificationText';
import getSteamApiKey from '../lib/getSteamApiKey';
import withTimeout from '../lib/withTimeout';
import { fetchPlayerSummary } from '../lib/steamPlayerSummary';
import {
  issueAntiLoopToken,
  hashAntiLoopToken,
  ANTI_LOOP_TOKEN_TTL_MS,
} from '../lib/analytics/db';

export const DEFAULT_NOTIFY_LOCALE = DEFAULT_WATCH_LOCALE;

/**
 * Issues a fresh single-use anti-loop token and returns the RAW value for
 * embedding in the outgoing player-page link (only the hash is stored).
 * Overwrites unconditionally — see sendNotifyMessage for why reusing an
 * existing token is impossible. A storage failure rejects (fail closed:
 * the caller must not send a tokenless link).
 */
export const issueFreshAntiLoopToken = async (
  steamId: string,
): Promise<string> => {
  const antiLoopToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ANTI_LOOP_TOKEN_TTL_MS).toISOString();
  await issueAntiLoopToken(steamId, hashAntiLoopToken(antiLoopToken), expiresAt);
  return antiLoopToken;
};

/** Watchdog for the nickname lookup: a hang must not delay the notify. */
const NICKNAME_TIMEOUT_MS = 5000;

/**
 * Resolves the watched profile's display name for the notify text.
 * Best-effort by design: returns null (caller falls back to the
 * steamId-URL phrasing) on ANY failure — missing key, timeout, unknown
 * profile. A display name must never cost a notification, and a Steam API
 * outage must degrade to plainer text, not to silence. Never throws.
 *
 * Deliberately a local fetch, not getSteamIdentity: that helper imports
 * react/cache (fine in Next, fragile in this ts-node process) and carries
 * cross-request TTL semantics the poller does not want — one lookup per
 * delivered notify is cheap at notify volumes (≤ batchLimit per minute).
 */
export const resolveNotifyDisplayName = async (
  steamId: string,
): Promise<string | null> => {
  const apiKey = getSteamApiKey();
  if (!apiKey) return null;
  const player = await withTimeout(
    fetchPlayerSummary(steamId, apiKey),
    'resolveNotifyDisplayName: GetPlayerSummaries',
    NICKNAME_TIMEOUT_MS,
  ).catch(() => null);
  const nickname = player?.personaname;
  if (typeof nickname !== 'string' || nickname === '') return null;
  // Steam personaname is free-form user input (emoji, bidi overrides,
  // C0/C1 control chars, arbitrarily long). It is interpolated into a
  // Steam chat line and the site inbox: strip what breaks rendering —
  // C0/C1 controls (incl. line-break injection) AND bidi controls
  // (U+200E/U+200F, U+202A–U+202E, U+2066–U+2069 — a U+202E flips
  // everything after it visually) — and cap length (codepoint-aware,
  // never splitting surrogate pairs) so one creative username cannot
  // blow up the message layout. Returns null when nothing printable
  // remains (caller falls back to the plain phrasing).
  const cleaned = Array.from(
    // Stripping control characters IS the point here (chat line-break
    // injection + visual-spoofing defense) — the ranges are intentional,
    // not accidental.
    // eslint-disable-next-line no-control-regex
    nickname.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim(),
  )
    .slice(0, 32)
    .join('');
  return cleaned === '' ? null : cleaned;
};

/**
 * Resolves the notify text for a requester locale ('pt-BR' -> 'pt'),
 * falling back to English for anything unknown or absent. Never throws
 * (unknown locales must degrade to English, not crash the poller).
 */
export const getNotifyMessage = (
  locale: string | null | undefined,
  steamId: string,
  nickname: string | null = null,
  siteUrl: string | null = null,
  antiLoopToken: string | null = null,
): string =>
  getNotifyText(locale, steamId, { nickname, siteUrl, antiLoopToken });

/**
 * Minimal structural surface of the Steam chat sender (steam-user's
 * chat.sendFriendMessage is promise-based in the installed v5 — verified
 * in components/chatroom.js — but absent from @types/steam-user, hence
 * this interface instead of the library type). NOTE: the Epic text says
 * "chatMessage", but that is the deprecated wrapper
 * (components/chat.js delegates it to chat.sendFriendMessage); callers
 * must use sendFriendMessage directly.
 */
export interface NotifyChatClient {
  sendFriendMessage: (steamId: string, message: string) => Promise<unknown>;
}

/** Sends the localized notify text. Lets send failures propagate. */
export const sendNotifyMessage = async (
  chat: NotifyChatClient,
  steamId: string,
  locale: string | null | undefined,
  siteUrl: string | null = null,
): Promise<void> => {
  // Same untyped-boundary guard as the welcome sender: fail with a clear
  // operational message instead of a generic TypeError.
  if (typeof chat?.sendFriendMessage !== 'function') {
    throw new Error(
      'Steam chat sender unavailable: sendFriendMessage is not a function',
    );
  }
  // Always issue a FRESH token, unconditionally overwriting any previous
  // one. An "issue-if-absent" check here would be a trap: when a valid
  // token already exists we cannot reuse it (only the hash is stored —
  // the raw value left with the previous message), so that branch would
  // send a tokenless message while claiming loop protection. Overwriting
  // invalidates an older unclicked link, which is the safe direction
  // (a dead link fails closed to a normal recorded search).
  // The two independent awaits (nickname lookup, token issue) run in
  // parallel: the poller is sequential per row by design, but there is no
  // reason to serialize two unrelated I/Os inside one send. Either
  // rejection propagates (fail closed: no tokenless message ever sends).
  const [nickname, antiLoopToken] = await Promise.all([
    resolveNotifyDisplayName(steamId),
    issueFreshAntiLoopToken(steamId),
  ]);

  await chat.sendFriendMessage(
    steamId,
    getNotifyMessage(locale, steamId, nickname, siteUrl, antiLoopToken),
  );
};

/**
 * Sends the signup-confirmation link (navbar-global flow). Same sender
 * contract as notifies; failures propagate to the caller's per-row
 * isolation (reconcile), never aborting the pass.
 */
export const sendConfirmMessage = async (
  chat: NotifyChatClient,
  steamId: string,
  locale: string | null | undefined,
  url: string,
): Promise<void> => {
  if (typeof chat?.sendFriendMessage !== 'function') {
    throw new Error(
      'Steam chat sender unavailable: sendFriendMessage is not a function',
    );
  }
  await chat.sendFriendMessage(steamId, getConfirmText(locale, url));
};

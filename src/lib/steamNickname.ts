/**
 * Single shared Steam personaname sanitizer — the one definition both the
 * bot (resolveNotifyDisplayName) and the site navbar (getSteamIdentity)
 * must use, so the two surfaces can never drift apart again.
 *
 * Steam personaname is free-form attacker-controlled input (emoji, bidi
 * overrides, C0/C1 controls, arbitrarily long, BBCode-looking brackets).
 * It is interpolated into a Steam chat line (bot) and into navbar HTML
 * (site): strip what breaks rendering or enables spoofing —
 * - C0/C1 controls (incl. line-break injection),
 * - bidi controls (U+200E/U+200F, U+202A–U+202E, U+2066–U+2069 — a U+202E
 *   flips everything after it visually),
 * - `[` / `]` (Steam renders bracket markup as BBCode — a nickname like
 *   `x[url=http://phish.example]click[/url]` inside the bot's official
 *   message would be a phishing primitive; clan tags like `[ABC]` lose
 *   their brackets, accepted: safety over decoration),
 * and cap length codepoint-aware (never splitting surrogate pairs) so one
 * creative username cannot blow up the message layout.
 *
 * Returns null when nothing printable remains (callers fall back to the
 * plain phrasing / steamId). Never throws.
 *
 * Dependency-free and alias-free on purpose (same contract as
 * steamPlayerSummary): the ts-node bot imports this via a RELATIVE path,
 * Next via `@/`.
 */

export const STEAM_NICKNAME_MAX_LENGTH = 32;

export const sanitizeSteamNickname = (nickname: unknown): string | null => {
  if (typeof nickname !== 'string') return null;
  // Strip C0/C1 controls + bidi overrides first (no-control-regex is
  // intentional here — these characters are the attack surface).
  // eslint-disable-next-line no-control-regex
  let cleaned = nickname.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  // Then strip literal brackets (BBCode / phishing vectors).
  // eslint-disable-next-line no-useless-escape
  cleaned = cleaned.replace(/[\[\]]/g, '');
  // Codepoint-aware cap (never splits surrogate pairs).
  const result = Array.from(cleaned)
    .slice(0, STEAM_NICKNAME_MAX_LENGTH)
    .join('');
  return result === '' ? null : result;
};
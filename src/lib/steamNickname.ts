/**
 * Single shared Steam personaname sanitizer — the one definition both the
 * bot (resolveNotifyDisplayName) and the site navbar (getSteamIdentity)
 * must use, so the two surfaces can never drift apart again.
 *
 * Steam personaname is free-form attacker-controlled input (emoji, bidi
 * overrides, C0/C1 controls, arbitrarily long, BBCode-looking brackets).
 * What gets stripped depends on WHERE the name renders (see options):
 * controls, bidi overrides and the length cap apply EVERYWHERE (a U+202E
 * flips everything after it visually in a browser just as in chat);
 * brackets are only dangerous where Steam itself renders markup.
 *
 * Returns null when nothing printable remains (callers fall back to the
 * plain phrasing / steamId). Never throws.
 *
 * Dependency-free and alias-free on purpose (same contract as
 * steamPlayerSummary): the ts-node bot imports this via a RELATIVE path,
 * Next via `@/`.
 */

export const STEAM_NICKNAME_MAX_LENGTH = 32;

export interface SanitizeSteamNicknameOptions {
  /**
   * Strip `[` / `]` (default true). Brackets are ONLY dangerous where
   * Steam itself renders markup: Steam chat interprets BBCode, so a
   * nickname smuggling `x[url=http://phish.example]click[/url]` inside
   * the bot's official message would be a phishing primitive. Our own
   * HTML (React-escaped navbar, dashboard, inbox) renders brackets
   * inertly, so the navbar passes false and clan tags like `[NAVI]`
   * survive intact there.
   */
  stripBrackets?: boolean;
}

export const sanitizeSteamNickname = (
  nickname: unknown,
  options: SanitizeSteamNicknameOptions = {},
): string | null => {
  if (typeof nickname !== 'string') return null;
  const { stripBrackets = true } = options;
  // Strip C0/C1 controls + bidi overrides first (no-control-regex is
  // intentional here — these characters are the attack surface).
  // eslint-disable-next-line no-control-regex
  let cleaned = nickname.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  // Then strip literal brackets (BBCode / phishing vectors) — chat
  // surfaces only (see the option contract above).
  if (stripBrackets) {
    // eslint-disable-next-line no-useless-escape
    cleaned = cleaned.replace(/[\[\]]/g, '');
  }
  // Codepoint-aware cap (never splits surrogate pairs).
  const result = Array.from(cleaned)
    .slice(0, STEAM_NICKNAME_MAX_LENGTH)
    .join('');
  return result === '' ? null : result;
};
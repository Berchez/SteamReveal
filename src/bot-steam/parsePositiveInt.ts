/**
 * Shared positive-integer env parsing for the Watch Bot.
 *
 * Lives here (instead of inside config.ts) so scripts/healthcheck-bot.ts can
 * reuse the exact same contract without importing the bot config module —
 * which would require bot credentials env vars just to check health. Both
 * callers share the failure semantics: missing/empty resolves to the
 * caller's fallback, anything else that is not a positive integer throws
 * naming the variable.
 *
 * Integers only (deliberately stricter than Number()): a fractional "0.5"
 * would floor to 0 downstream and silently turn the setting into "always
 * expired" — reject it loudly here instead.
 *
 * Default export (single-export module, repo convention — see
 * watchInviteCooldown, sqlStatements).
 */

const parsePositiveInt = (
  raw: string | undefined,
  name: string,
): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  return parsed;
};

export default parsePositiveInt;

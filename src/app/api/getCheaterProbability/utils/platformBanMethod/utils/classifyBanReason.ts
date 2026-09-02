export type BanClassification = 'cheat' | 'smurf' | 'other';

const CHEAT_REASON_PATTERN =
  /anti[\s_-]?cheat|anticheat|\bcheat\b|cheating|wallhack|wall hack|\bhack\b|aimbot/i;
const SMURF_REASON_PATTERN =
  /\bsmurf\b|smurfing|conta secund[áa]ria|secondary account|second account|alt account|conta alternativa/i;

/**
 * Classifies a platform ban reason into a signal direction.
 *
 * - 'cheat'  -> the player was banned for cheating / anti-cheat. Strong signal
 *               that raises the cheater probability.
 * - 'smurf'  -> banned for using a secondary / smurf account. Typically a
 *               legit skilled player, so it LOWERS the cheater probability.
 * - 'other'  -> some other / unknown reason. Neutral, no probability change.
 *
 * Matching is intentionally broad and locale-tolerant (PT + EN keywords).
 * If the reason is missing or unrecognized it resolves to 'other' (the safe
 * neutral default) rather than guessing.
 */
const classifyBanReason = (
  reason: string | null | undefined,
): BanClassification => {
  if (!reason) return 'other';

  if (CHEAT_REASON_PATTERN.test(reason)) return 'cheat';
  if (SMURF_REASON_PATTERN.test(reason)) return 'smurf';

  return 'other';
};

export default classifyBanReason;

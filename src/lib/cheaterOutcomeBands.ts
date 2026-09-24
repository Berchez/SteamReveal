import { ReportOutcomes, ReportOutcomeKey } from '@/@types/cheaterReportTypes';

/**
 * Single source of truth for the cheater-report outcome bands.
 *
 * Consumers:
 * - src/app/templates/Home/sections/CheaterReport/utils.ts (runtime
 *   classification, 0-1 scale) — via classifyCheaterOutcome().
 * - src/lib/analytics/dashboardTemplate.ts (build-time interpolation into
 *   the dashboard's inline JS, 0-100 scale) — via the _PERCENT variant.
 *
 * The STRICTNESS of each boundary is part of the contract (> vs >=) and
 * is preserved in classifyCheaterOutcome — do not "simplify" it away.
 * These bands were calibrated on the observed n=191 production
 * distribution (2026-09-24: min 0.04, p25 0.46, median 0.50, max 0.74);
 * revisit together if the model is ever retrained/calibrated.
 *
 * Note: n=191 is a SMALL sample and the INCONCLUSIVE window (0.45-0.58)
 * sits where the distribution is densest (p25-median), so small model
 * noise can flip verdicts there. The cuts are intentionally conservative
 * (the old >0.8 HIGHLY_SUSPECT band was unreachable — max observed 0.74)
 * but treat them as INTERIM: re-validate against a larger sample and get
 * an explicit product/data sign-off before tightening them further.
 */
export const CHEATER_OUTCOME_THRESHOLDS = {
  /** <= this → VERY_TRUSTED */
  VERY_TRUSTED_MAX: 0.2,
  /** >= this (and <= SUSPECT_MIN) → INCONCLUSIVE */
  INCONCLUSIVE_MIN: 0.45,
  /** > this (and <= HIGHLY_SUSPECT_MIN) → SUSPECT */
  SUSPECT_MIN: 0.58,
  /** > this → HIGHLY_SUSPECT */
  HIGHLY_SUSPECT_MIN: 0.65,
} as const;

/**
 * Same cuts scaled to the 0-100 percentages the dashboard's inline JS uses
 * (normalizeScore output). Derived programmatically — never hand-duplicated
 * — so the two scales cannot drift. Math.round absorbs the float error
 * (0.58 * 100 === 57.999... in IEEE754, but the intended cut is 58).
 */
const toPercent = (fraction: number): number => Math.round(fraction * 100);

export const CHEATER_OUTCOME_THRESHOLDS_PERCENT = {
  VERY_TRUSTED_MAX: toPercent(CHEATER_OUTCOME_THRESHOLDS.VERY_TRUSTED_MAX),
  INCONCLUSIVE_MIN: toPercent(CHEATER_OUTCOME_THRESHOLDS.INCONCLUSIVE_MIN),
  SUSPECT_MIN: toPercent(CHEATER_OUTCOME_THRESHOLDS.SUSPECT_MIN),
  HIGHLY_SUSPECT_MIN: toPercent(
    CHEATER_OUTCOME_THRESHOLDS.HIGHLY_SUSPECT_MIN,
  ),
} as const;

/**
 * Maps a 0-1 cheater probability to its outcome band. Boundary behavior:
 * 0.2 → VERY_TRUSTED (<=), 0.45 → INCONCLUSIVE (>=), 0.58 → INCONCLUSIVE
 * (not > SUSPECT_MIN), 0.65 → SUSPECT (not > HIGHLY_SUSPECT_MIN).
 */
export const classifyCheaterOutcome = (
  probability: number,
): ReportOutcomeKey => {
  if (probability > CHEATER_OUTCOME_THRESHOLDS.HIGHLY_SUSPECT_MIN) {
    return ReportOutcomes.HIGHLY_SUSPECT;
  }
  if (probability > CHEATER_OUTCOME_THRESHOLDS.SUSPECT_MIN) {
    return ReportOutcomes.SUSPECT;
  }
  if (probability >= CHEATER_OUTCOME_THRESHOLDS.INCONCLUSIVE_MIN) {
    return ReportOutcomes.INCONCLUSIVE;
  }
  if (probability > CHEATER_OUTCOME_THRESHOLDS.VERY_TRUSTED_MAX) {
    return ReportOutcomes.INNOCENT;
  }
  return ReportOutcomes.VERY_TRUSTED;
};

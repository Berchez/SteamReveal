import {
  CHEATER_OUTCOME_THRESHOLDS,
  CHEATER_OUTCOME_THRESHOLDS_PERCENT,
  classifyCheaterOutcome,
} from './cheaterOutcomeBands';

describe('cheaterOutcomeBands', () => {
  describe('classifyCheaterOutcome', () => {
    it('classifies the five bands by their boundaries', () => {
      expect(classifyCheaterOutcome(0.2)).toBe('veryTrusted');
      expect(classifyCheaterOutcome(0.21)).toBe('innocent');
      expect(classifyCheaterOutcome(0.45)).toBe('inconclusive');
      expect(classifyCheaterOutcome(0.58)).toBe('inconclusive');
      expect(classifyCheaterOutcome(0.59)).toBe('suspect');
      expect(classifyCheaterOutcome(0.65)).toBe('suspect');
      expect(classifyCheaterOutcome(0.66)).toBe('highlySuspect');
    });

    it('keeps the strictness contract at every boundary', () => {
      // <= VERY_TRUSTED_MAX is veryTrusted; one above flips to innocent.
      expect(classifyCheaterOutcome(CHEATER_OUTCOME_THRESHOLDS.VERY_TRUSTED_MAX))
        .toBe('veryTrusted');
      // >= INCONCLUSIVE_MIN is inconclusive; one below is innocent.
      expect(
        classifyCheaterOutcome(CHEATER_OUTCOME_THRESHOLDS.INCONCLUSIVE_MIN),
      ).toBe('inconclusive');
      // > SUSPECT_MIN is suspect; exactly at it is inconclusive.
      expect(
        classifyCheaterOutcome(CHEATER_OUTCOME_THRESHOLDS.SUSPECT_MIN),
      ).toBe('inconclusive');
      // > HIGHLY_SUSPECT_MIN is highly; exactly at it is suspect.
      expect(
        classifyCheaterOutcome(CHEATER_OUTCOME_THRESHOLDS.HIGHLY_SUSPECT_MIN),
      ).toBe('suspect');
    });
  });

  it('derives whole-number percents from the fractions', () => {
    // The percent variant is computed (not hand-written), so this pins the
    // derivation output rather than a sync between two literals. All cuts
    // must stay whole numbers — the dashboard interpolates them into label
    // strings like "Suspect (58-65%)".
    expect(CHEATER_OUTCOME_THRESHOLDS_PERCENT).toEqual({
      VERY_TRUSTED_MAX: 20,
      INCONCLUSIVE_MIN: 45,
      SUSPECT_MIN: 58,
      HIGHLY_SUSPECT_MIN: 65,
    });
  });
});

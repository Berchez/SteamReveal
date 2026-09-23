import {
  getAccountAge,
  getAccountAgeMonths,
  toNumericFeature,
} from './utils';

const summaryWith = (createdAt: unknown) => ({ createdAt }) as never;

describe('getAccountAge / getAccountAgeMonths', () => {
  it('returns whole years and months for a past creation date', () => {
    // ~400 days ago: 1 full year, ~13 full months.
    const createdAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

    expect(getAccountAge(summaryWith(createdAt))).toBe(1);
    expect(getAccountAgeMonths(summaryWith(createdAt))).toBe(13);
  });

  it('returns 0 years with a month count for sub-one-year accounts', () => {
    // ~100 days ago: 0 full years, 3 full months — never "0 years old".
    const createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

    expect(getAccountAge(summaryWith(createdAt))).toBe(0);
    expect(getAccountAgeMonths(summaryWith(createdAt))).toBe(3);
  });

  it('accepts unix-seconds numbers and date strings like the Steam API shapes', () => {
    const seconds = Math.floor(
      (Date.now() - 800 * 24 * 60 * 60 * 1000) / 1000,
    );

    expect(getAccountAge(summaryWith(seconds))).toBe(2);
    expect(getAccountAgeMonths(summaryWith(seconds))).toBeGreaterThanOrEqual(
      26,
    );
    expect(
      getAccountAge(summaryWith(new Date(seconds * 1000).toISOString())),
    ).toBe(2);
  });

  it('coerces cleaned stat strings to numbers for the model feature vector', () => {
    expect(toNumericFeature('85.5')).toBe(85.5);
    expect(toNumericFeature('150')).toBe(150);
    expect(toNumericFeature('0')).toBe(0);
  });

  it('degrades missing or unparseable stats to the -1 sentinel, never NaN', () => {
    expect(toNumericFeature(undefined)).toBe(-1);
    expect(toNumericFeature('')).toBe(-1);
    expect(toNumericFeature('   ')).toBe(-1);
    expect(toNumericFeature('N/A')).toBe(-1);
    // NaN must never reach the Flask payload (JSON.stringify(NaN) is null).
    const result = toNumericFeature('abc');
    expect(result).toBe(-1);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('returns undefined when the creation date is missing or unresolvable', () => {
    expect(getAccountAge(summaryWith(undefined))).toBeUndefined();
    expect(getAccountAgeMonths(summaryWith(undefined))).toBeUndefined();
    expect(getAccountAge(summaryWith(null))).toBeUndefined();
    expect(getAccountAgeMonths(summaryWith(null))).toBeUndefined();
    expect(getAccountAge(summaryWith('not-a-date'))).toBeUndefined();
    expect(getAccountAgeMonths(summaryWith('not-a-date'))).toBeUndefined();
  });
});

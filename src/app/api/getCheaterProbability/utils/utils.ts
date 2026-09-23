import { UserSummary } from 'steamapi';

// Resolve account creation timestamp to milliseconds
const resolveCreatedAtMs = (value: unknown): number | undefined => {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'number') {
    return value * 1000;
  }

  if (value) {
    return new Date(value as string).getTime();
  }

  return undefined;
};

export const clearStat = (stat: string) => {
  const cleaned = stat.replace('ms', '').replace('%', '').trim();

  return cleaned === '' ? undefined : cleaned;
};

/**
 * Coerces a cleaned CS-stat value into the number the Flask model expects.
 * CsStats fields travel as strings (missing data is ''), so without this
 * the feature vector would ship numeric strings — or worse, a non-numeric
 * string — to /predict. Anything unparseable degrades to the -1
 * missing-data sentinel (never NaN: JSON.stringify(NaN) is null, which the
 * model endpoint would receive as a null feature).
 */
export const toNumericFeature = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') return -1;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
};

export const getAccountAge = (userSummary: UserSummary) => {
  const createdAtMs = resolveCreatedAtMs(userSummary.createdAt);
  const accountAge =
    createdAtMs && !Number.isNaN(createdAtMs)
      ? Math.floor((Date.now() - createdAtMs) / (1000 * 60 * 60 * 24 * 365.25))
      : undefined;

  return accountAge;
};

// Same clock as getAccountAge, in whole months — so sub-one-year accounts
// render "N months old" instead of "0 years old". Undefined under the same
// missing/unresolvable conditions as getAccountAge.
export const getAccountAgeMonths = (userSummary: UserSummary) => {
  const createdAtMs = resolveCreatedAtMs(userSummary.createdAt);
  const accountAgeMonths =
    createdAtMs && !Number.isNaN(createdAtMs)
      ? Math.floor((Date.now() - createdAtMs) / (1000 * 60 * 60 * 24 * 30.44))
      : undefined;

  return accountAgeMonths;
};

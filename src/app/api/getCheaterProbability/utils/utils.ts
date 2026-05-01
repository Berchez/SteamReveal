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

export const getAccountAge = (userSummary: UserSummary) => {
  const createdAtMs = resolveCreatedAtMs(userSummary.createdAt);
  const accountAge =
    createdAtMs && !Number.isNaN(createdAtMs)
      ? Math.floor((Date.now() - createdAtMs) / (1000 * 60 * 60 * 24 * 365.25))
      : undefined;

  return accountAge;
};

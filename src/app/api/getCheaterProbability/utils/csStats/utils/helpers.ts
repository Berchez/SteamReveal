import { LeetifyGame } from '@/@types/csStatsTypes';
import { AxiosRequestConfig } from 'axios';

export const sharedHeaders: AxiosRequestConfig['headers'] = process.env
  .LEETIFY_API_KEY
  ? { _leetify_key: process.env.LEETIFY_API_KEY }
  : undefined;

/** Trims the value and returns empty string for blank / "N/A" inputs. */
export const normalize = (value?: string | number | null): string => {
  const str = String(value ?? '').trim();
  return str.toUpperCase() === 'N/A' || str === 'UNDEFINED' || str === ''
    ? ''
    : str;
};

/** Converts a 0-1 winrate fraction to a rounded percentage string, e.g. "54". */
export const formatWinrate = (fraction?: number): string =>
  fraction != null && !Number.isNaN(fraction)
    ? String(Math.round(fraction * 100))
    : '';

/** Calculates winrate from a games array as a fallback. */
export const calculateWinrateFromGames = (games: LeetifyGame[]): string => {
  if (!games.length) return '';
  const wins = games.filter((g) => g.matchResult === 'win').length;
  return formatWinrate(wins / games.length);
};

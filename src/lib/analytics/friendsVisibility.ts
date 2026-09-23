/**
 * Friends-list visibility value (private-list degraded mode).
 *
 * Single source of truth for the settled outcomes of the friends pipeline:
 * - 'public': the list resolved normally.
 * - 'private': Steam refused the list (private/inaccessible) — the search
 *   ran degraded (profile + self-declared location only).
 * - 'empty': the list resolved successfully but contains zero friends.
 *
 * Loading is represented by `undefined` at the call sites, legacy analytics
 * rows by `null` — neither lives here. This module is dependency-free on
 * purpose: the Turso DAL (db.ts), the route parser (input.ts) and the
 * migration scripts (scripts/migrate-utils.ts) all share it, and the
 * scripts must stay importable without pulling @libsql/client.
 */

export type FriendsVisibility = 'public' | 'private' | 'empty';

const FRIENDS_VISIBILITIES: readonly FriendsVisibility[] = [
  'public',
  'private',
  'empty',
];

/**
 * Only the three known values persist; anything else (legacy callers,
 * hand-built inputs, corrupt imports) degrades to null ("unknown"), never
 * to a mislabeled bucket. Never throws.
 */
export const normalizeFriendsVisibility = (
  value: unknown,
): FriendsVisibility | null =>
  typeof value === 'string' &&
  (FRIENDS_VISIBILITIES as readonly string[]).includes(value)
    ? (value as FriendsVisibility)
    : null;

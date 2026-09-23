import type { FriendsVisibility } from '@/lib/analytics/types';
import type { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';

/**
 * Friends-list visibility tri-state (private-list degraded mode).
 *
 * The friends pipeline has three settled outcomes, and the UI + analytics
 * must tell them apart: a PRIVATE list (Steam refused — degraded search)
 * is not the same as an EMPTY list (resolved fine, zero friends) nor a
 * PUBLIC one. Loading is represented by `undefined` at the call sites, so
 * this module only models settled states.
 *
 * Do NOT redeclare the value list here: the canonical type + normalizer
 * live in `@/lib/analytics/friendsVisibility` (dependency-free on purpose
 * so the DAL, route parser and migration scripts can share it). This file
 * only re-exports the type and adds client-side classifiers.
 */

export type { FriendsVisibility };

/** Successful close-friends payload → 'public' vs 'empty'. Never throws. */
export const visibilityFromCloseFriends = (
  closeFriends: closeFriendsDataIWant[] | undefined,
): Exclude<FriendsVisibility, 'private'> =>
  Array.isArray(closeFriends) && closeFriends.length > 0 ? 'public' : 'empty';

/**
 * Structured error code the route returns for a private list
 * (POST /api/getCloseFriends → 400 FRIENDS_LIST_PRIVATE). Matching the
 * code — not free-form copy — is what survives backend message refactors.
 */
export const FRIENDS_LIST_PRIVATE_CODE = 'FRIENDS_LIST_PRIVATE';

// Legacy fallback: the copy the route sends alongside the code. Kept so a
// response carrying the message without the code (proxies that strip
// fields, non-axios throwers in tests) still classifies.
const PRIVATE_MESSAGE_PATTERN =
  /friends list is private or inaccessible|friend list.*not public/i;

const readErrorCode = (responseData: unknown): string | undefined => {
  if (!responseData || typeof responseData !== 'object') return undefined;
  const data = responseData as Record<string, unknown>;
  const nested = data.error as Record<string, unknown> | undefined;
  const code =
    (typeof nested?.code === 'string' ? nested.code : undefined) ??
    (typeof data.code === 'string' ? data.code : undefined);
  return code;
};

const readErrorMessage = (
  responseData: unknown,
  fallback: unknown,
): string | undefined => {
  if (responseData && typeof responseData === 'object') {
    const data = responseData as Record<string, unknown>;
    const nested = data.error as Record<string, unknown> | undefined;
    if (typeof nested?.message === 'string') return nested.message;
    if (typeof data.error === 'string') return data.error;
    if (typeof data.message === 'string') return data.message;
  }
  return typeof fallback === 'string' ? fallback : undefined;
};

/**
 * True when a /api/getCloseFriends failure means "private list", as opposed
 * to timeouts / 500s / validation errors which keep the old abort path.
 *
 * Primary signal is the structured FRIENDS_LIST_PRIVATE code on a 400
 * (matching what errorResponse actually serializes:
 * `{ error: { message, code } }` — note `error` is an OBJECT, so naive
 * `response.data.error === 'string'` checks never fire in production).
 * The message pattern is a secondary fallback for code-less responses.
 * Never throws.
 */
export const isPrivateFriendsError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;

  const response = record.response as Record<string, unknown> | undefined;
  const status =
    typeof response?.status === 'number' ? response.status : undefined;
  if (status !== undefined && status !== 400) return false;

  const responseData = response?.data;
  if (readErrorCode(responseData) === FRIENDS_LIST_PRIVATE_CODE) return true;

  const message = readErrorMessage(responseData, record.message);
  return !!message && PRIVATE_MESSAGE_PATTERN.test(message);
};

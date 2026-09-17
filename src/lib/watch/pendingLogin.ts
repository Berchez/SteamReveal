/**
 * Pending login via iron-session (login-first flow) — server-side only.
 *
 * Holds an OpenID-VERIFIED identity (the callback already proved it with
 * Steam) for a user who is not yet the bot's friend, so the waiting room
 * can complete the login the moment the friendship appears — without a
 * second OpenID dance. Same sealed-cookie construction as the watch
 * session (iron-session, SESSION_SECRET, httpOnly + SameSite=Lax), with a
 * deliberately short life (30 minutes):
 *
 * - Long enough to cover the slow-normal path (missed live-accept event →
 *   10-minute reconcile sweep → detection) plus ordinary user slowness
 *   (tab switching, coffee).
 * - Short enough that a stolen cookie is a bounded 30-minute window — and
 *   theft buys nothing beyond what stealing the subsequent session would:
 *   completion still re-proves the friendship server-side, and the pending
 *   payload authorizes exactly one identity (no privilege to borrow).
 * - NOT long enough for next-UTC-day budget rollover or manual friend-cap
 *   pruning: those land on the expired copy ("try again later"), by
 *   design — a 24h pending would trade a rare retry for a wide theft
 *   window, and re-doing OpenID is one click for a Steam-authed browser.
 *
 * Non-single-use by construction (no store — the repo's no-new-
 * infrastructure constraint): replaying within the TTL only re-completes
 * for the same browser holding the cookie, and completion is idempotent
 * (ensureActiveWatch converges, welcome fires once per real activation).
 */

import { getIronSession, type CookieStore } from 'iron-session';

import { isSteamId64 } from '@/lib/steamId';

import { getSessionPassword } from './session';
import {
  PENDING_LOGIN_COOKIE,
  type PendingLoginData,
} from './sessionCookie';

/** 30 minutes, in the units each consumer needs. */
export const PENDING_LOGIN_TTL_SECONDS = 30 * 60;
export const PENDING_LOGIN_TTL_MS = PENDING_LOGIN_TTL_SECONDS * 1000;

export const createPendingLoginData = (
  steamId: string,
  next: string,
): PendingLoginData => {
  if (!isSteamId64(steamId)) {
    throw new Error('Invalid SteamID64 for pending login: expected 17 digits');
  }
  // `next` arrives validated as an internal path by the callback (and is
  // re-validated at completion) — stored as given, never trusted blindly.
  return {
    kind: 'pending-login',
    steamId,
    next,
    expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
  };
};

/** Shape + absolute-expiry check (same belt-and-braces as the session). */
export const isPendingLoginDataValid = (
  data: unknown,
): data is PendingLoginData => {
  if (typeof data !== 'object' || data === null) return false;
  const { kind, steamId, next, expiresAt } = data as Record<string, unknown>;
  if (kind !== 'pending-login') return false;
  if (!isSteamId64(steamId)) return false;
  if (typeof next !== 'string' || next.length === 0) return false;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false;
  }
  return Date.now() < expiresAt;
};

const pendingLoginOptions = () => ({
  password: getSessionPassword(),
  cookieName: PENDING_LOGIN_COOKIE,
  ttl: PENDING_LOGIN_TTL_SECONDS,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
});

/**
 * Verified pending identity, or null (absent/tampered/expired/invalid).
 * Never throws for bad cookies — same iron-session posture as the session
 * layer. Crypto-layer failures (e.g. rotated SESSION_SECRET mid-wait) also
 * resolve to null: the room shows "start over", never a 500.
 */
export const getPendingLogin = async (
  cookieStore: CookieStore,
): Promise<PendingLoginData | null> => {
  try {
    const pending = await getIronSession<PendingLoginData>(
      cookieStore,
      pendingLoginOptions(),
    );
    return isPendingLoginDataValid(pending) ? pending : null;
  } catch {
    return null;
  }
};

/** Persists a fresh pending login for an OpenID-verified SteamID64. */
export const savePendingLogin = async (
  cookieStore: CookieStore,
  steamId: string,
  next: string,
): Promise<void> => {
  const pending = await getIronSession<PendingLoginData>(
    cookieStore,
    pendingLoginOptions(),
  );
  Object.assign(pending, createPendingLoginData(steamId, next));
  await pending.save();
};

/** Clears the pending-login cookie (consumed or abandoned). Never throws. */
export const clearPendingLogin = async (
  cookieStore: CookieStore,
): Promise<void> => {
  const pending = await getIronSession<PendingLoginData>(
    cookieStore,
    pendingLoginOptions(),
  );
  await pending.destroy();
};

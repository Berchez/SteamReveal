/**
 * Watch session via iron-session (Steam OpenID login) — server-side only.
 *
 * Sealed (encrypted, not merely signed) httpOnly + SameSite=Lax cookie
 * carrying ONLY `{ steamId, expiresAt }`: no user table, no session store,
 * no new infrastructure (the repo's no-recurring-cost constraint). The
 * SteamID64 inside was verified by the OpenID callback, so every consumer
 * treats it as the authenticated user — never accept a steamId from the
 * client alongside it.
 *
 * Why iron-session and not hand-rolled JWT/HMAC: sealed cookies need no
 * key-rotation protocol, no server store, and no crypto review of our own.
 * iron-session v9 is ESM-only, so unit tests mock the 'iron-session'
 * module (logic is tested against the mock; the real seal/unseal roundtrip
 * is exercised by e2e/watch.spec.ts through the real Next server).
 */

import { getIronSession, type CookieStore } from 'iron-session';

import { isSteamId64 } from '@/lib/steamId';

import { WATCH_SESSION_COOKIE, type WatchSessionData } from './sessionCookie';

/** 30 days, in the units each consumer needs. */
export const WATCH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const WATCH_SESSION_TTL_MS = WATCH_SESSION_TTL_SECONDS * 1000;

/**
 * Sealing password from env. Throws loudly when missing/short:
 * iron-session requires 32+ chars, and a route that silently ran without
 * sessions would be an auth hole, not a degraded feature.
 */
export const getSessionPassword = (): string => {
  const secret = process.env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or too short (expected 32+ chars) — set it in .env (see .env.example). Auth routes cannot run without it.',
    );
  }
  return secret;
};

export const createSessionData = (steamId: string): WatchSessionData => {
  if (!isSteamId64(steamId)) {
    throw new Error('Invalid SteamID64 for session: expected 17 digits');
  }
  return { steamId, expiresAt: Date.now() + WATCH_SESSION_TTL_MS };
};

/** Shape + absolute-expiry check (belt over iron-session's own ttl). */
export const isSessionDataValid = (data: unknown): data is WatchSessionData => {
  if (typeof data !== 'object' || data === null) return false;
  const { steamId, expiresAt } = data as Record<string, unknown>;
  if (!isSteamId64(steamId)) return false;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false;
  }
  return Date.now() < expiresAt;
};

const sessionOptions = () => ({
  password: getSessionPassword(),
  cookieName: WATCH_SESSION_COOKIE,
  ttl: WATCH_SESSION_TTL_SECONDS,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
});

/**
 * Verified session SteamID64, or null (absent/tampered/expired/invalid).
 * Never throws for bad cookies — iron-session resets those to an empty
 * session by design, and the explicit expiresAt check covers the rest.
 * Pass next/headers cookies() directly (typed to iron-session's store).
 */
export const getSessionSteamId = async (
  cookieStore: CookieStore,
): Promise<string | null> => {
  const session = await getIronSession<WatchSessionData>(
    cookieStore,
    sessionOptions(),
  );
  return isSessionDataValid(session) ? session.steamId : null;
};

/** Persists a fresh session for a verified SteamID64. */
export const saveWatchSession = async (
  cookieStore: CookieStore,
  steamId: string,
): Promise<void> => {
  const session = await getIronSession<WatchSessionData>(
    cookieStore,
    sessionOptions(),
  );
  Object.assign(session, createSessionData(steamId));
  await session.save();
};

/** Clears the session cookie (logout). Never throws for absent cookies. */
export const destroyWatchSession = async (
  cookieStore: CookieStore,
): Promise<void> => {
  const session = await getIronSession<WatchSessionData>(
    cookieStore,
    sessionOptions(),
  );
  await session.destroy();
};

export type SessionResolution =
  | { status: 'authenticated'; steamId: string }
  | { status: 'unauthenticated' }
  | { status: 'error'; error: unknown };

/**
 * Shared session preamble for the self-scoped watch routes (request /
 * status / notifications): one call distinguishes "logged in" from "no
 * session" from "session layer blew up", so every route answers the same
 * way by construction (401 / 500) instead of each re-deriving it. Routes
 * map 'error' to a loud 500 with their own route name for the log line.
 */
export const resolveWatchSession = async (
  cookieStore: CookieStore,
): Promise<SessionResolution> => {
  let steamId: string | null;
  try {
    steamId = await getSessionSteamId(cookieStore);
  } catch (error) {
    return { status: 'error', error };
  }
  return steamId === null
    ? { status: 'unauthenticated' }
    : { status: 'authenticated', steamId };
};

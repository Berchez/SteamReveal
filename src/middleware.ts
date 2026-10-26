import createMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locales';
import {
  WATCH_SESSION_COOKIE,
  WATCH_SESSION_HINT_COOKIE,
  WATCH_SESSION_TTL_SECONDS,
} from './lib/watch/sessionCookie';

export default function middleware(request: NextRequest) {
  const localeMiddleware = createMiddleware({
    locales: [...SUPPORTED_LOCALES],
    defaultLocale: DEFAULT_LOCALE,
  });

  const response = localeMiddleware(request);

  // Keep the non-HttpOnly presence hint in sync for sessions sealed before
  // this cookie existed, and clear stale hints after logout/expiry. Only
  // requests carrying a session (or a stale hint) get a Set-Cookie header,
  // so anonymous ISR responses remain CDN-cacheable.
  const hasSession = request.cookies.has(WATCH_SESSION_COOKIE);
  const hasHint =
    request.cookies.get(WATCH_SESSION_HINT_COOKIE)?.value === '1';
  const cookieOptions = {
    httpOnly: false,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };

  if (hasSession && !hasHint) {
    response.cookies.set(WATCH_SESSION_HINT_COOKIE, '1', {
      ...cookieOptions,
      maxAge: WATCH_SESSION_TTL_SECONDS,
    });
  } else if (!hasSession && hasHint) {
    response.cookies.set(WATCH_SESSION_HINT_COOKIE, '', {
      ...cookieOptions,
      maxAge: 0,
    });
  }

  return response;
}

// IMPORTANT: Next.js expects literal strings in config.matcher. Avoid template
// literals with runtime expressions here to prevent the "Unsupported template
// literal" error during build.
export const config = {
  matcher: ['/', '/(en|pt|ru|de|es|fr|uk|pl)/:path*'],
};

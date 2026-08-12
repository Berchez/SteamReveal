import createMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locales';

export default function middleware(request: NextRequest) {
  const localeMiddleware = createMiddleware({
    locales: [...SUPPORTED_LOCALES],
    defaultLocale: DEFAULT_LOCALE,
  });

  const response = localeMiddleware(request);

  // Vercel Header with country (ex: 'BR', 'US', 'FR')
  const country =
    request.headers.get('x-vercel-ip-country') ||
    request.geo?.country || // Next.js geo API (Edge only)
    'UNKNOWN';

  // Send country to front via custom header
  response.headers.set('x-user-country', country);

  return response;
}

// IMPORTANT: Next.js expects literal strings in config.matcher. Avoid template
// literals with runtime expressions here to prevent the "Unsupported template
// literal" error during build.
export const config = {
  matcher: ['/', '/(en|pt|ru)/:path*'],
};

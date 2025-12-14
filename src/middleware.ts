import createMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';

export default function middleware(request: NextRequest) {
  const localeMiddleware = createMiddleware({
    // A list of all locales that are supported
    locales: ['en', 'pt'],
    // Used when no locale matches
    defaultLocale: 'en',
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

export const config = {
  // Match only internationalized pathnames
  matcher: ['/', '/(pt|en)/:path*'],
};

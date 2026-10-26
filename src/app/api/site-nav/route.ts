import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { resolveSiteNavState } from '@/app/components/SiteNav/siteNavState';
import { errorResponse } from '@/lib/apiError';
import { COUNTRY_COOKIE } from '@/lib/clientCountry';
import { normalizeCountryCode } from '@/lib/countryFlag';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export const revalidate = 0;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const siteNavRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

const COUNTRY_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export async function GET(req: NextRequest) {
  if (siteNavRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const state = await resolveSiteNavState(cookies());
  const response = NextResponse.json(state, {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Vary: 'Cookie',
    },
  });

  const existingCountry = normalizeCountryCode(
    req.cookies.get(COUNTRY_COOKIE)?.value,
  );
  if (existingCountry === null) {
    const country = normalizeCountryCode(
      req.headers.get('x-vercel-ip-country'),
    );
    if (country !== null) {
      response.cookies.set(COUNTRY_COOKIE, country, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: COUNTRY_COOKIE_MAX_AGE_SECONDS,
      });
    }
  }

  return response;
}

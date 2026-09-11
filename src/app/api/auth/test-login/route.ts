import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { isSteamId64 } from '@/lib/steamId';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import { saveWatchSession } from '@/lib/watch/session';

export const runtime = 'nodejs';

export const revalidate = 0;

/**
 * TEST-ONLY login for the WB e2e suite: seals a REAL session cookie (real
 * iron-session crypto on the real Next server) for a valid SteamID64,
 * without touching Steam OpenID — so Playwright exercises authenticated
 * flows deterministically, including the genuine seal/unseal roundtrip.
 *
 * Hard gate, same contract as devFixtures: DEV_TEST_MODE=1 AND
 * NODE_ENV!=production AND no VERCEL_ENV (which Vercel always sets), so
 * this 404s on every real deploy — staging, preview, and production
 * alike. Unit tests cover both sides of the gate.
 */
export async function POST(req: Request) {
  // App Router only routes POST here; kept as defense-in-depth (and so unit
  // tests can invoke POST() directly with other methods).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  const { isMockModeEnabled } = await import('@/mocks/devFixtures');
  if (!isMockModeEnabled()) {
    return errorResponse('Not found.', 404, 'NOT_FOUND');
  }

  // Second layer (defense in depth): a shared test-only secret, independent
  // of the env gate above. Rationale: on self-hosted deploys (no VERCEL_ENV
  // platform signal) the mock gate degrades to a single variable
  // (DEV_TEST_MODE) that a copied dev .env could set by accident. This
  // header has NO production value: the expected secret comes exclusively
  // from E2E_TEST_SECRET, which is set ONLY in the Playwright webServer env
  // and deliberately absent from .env.example — anywhere else, `expected`
  // is undefined and every caller 404s, no matter what header they send
  // (even the committed e2e value, which is public by design and useless
  // without a matching server env).
  const expected = process.env.E2E_TEST_SECRET;
  const received = req.headers.get('x-e2e-test-secret');
  if (
    typeof expected !== 'string' ||
    expected.length === 0 ||
    received === null ||
    !timingSafeEqualStrings(received, expected)
  ) {
    return errorResponse('Not found.', 404, 'NOT_FOUND');
  }

  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }
    logRouteError('testLogin', sanitizeError(error));
    return errorResponse(
      'Internal server error while test-logging in.',
      500,
      'INTERNAL_ERROR',
    );
  }

  const steamId = (body as { steamId?: unknown } | null)?.steamId;
  if (!isSteamId64(steamId)) {
    return errorResponse(
      'Invalid steamId: expected 17-digit SteamID64.',
      400,
      'INVALID_REQUEST',
    );
  }

  try {
    await saveWatchSession(cookies(), steamId);
    return NextResponse.json({ ok: true, steamId }, { status: 200 });
  } catch (error) {
    logRouteError('testLogin', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while test-logging in.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

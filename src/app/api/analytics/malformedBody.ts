import { errorResponse } from '@/lib/apiError';

/**
 * Shared malformed-beacon-body response for the recordAnalytics* family.
 *
 * Malformed bodies (double-stringified probes, single-quoted payloads,
 * keepalive-truncated posts) are routine internet noise on these public
 * fire-and-forget endpoints — warn, not error, so they stay out of
 * errors.log. The 400 stands.
 *
 * Deliberately logs NO error text: V8 SyntaxError messages embed an
 * attacker-controlled body excerpt, which must never reach logs raw (the
 * opsLog singleLine/text-shape discipline exists for the same reason).
 * The route name is the signal — malformed-beacon volume per route.
 * Console-only by design (unlike the bot warn lane): these routes run on
 * Vercel's read-only filesystem, where writeOpsLog degrades to
 * console-only anyway.
 *
 * Call this ONLY around `await req.json()`. A SyntaxError from anywhere
 * else (parser, DAL, JSON handling downstream) is a genuine bug and must
 * keep the loud 500 path — which is why each route isolates the body parse
 * in its own try/catch instead of relying on the outer catch-all.
 */
export const malformedBodyResponse = (routeName: string, error: unknown) => {
  const kind = error instanceof Error ? error.name : typeof error;
  // eslint-disable-next-line no-console
  console.warn(`${routeName} - malformed JSON body (${kind})`);
  return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
};

export default malformedBodyResponse;

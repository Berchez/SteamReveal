/**
 * Server-side lifetime for a confirmed GamersClub name/miss.
 *
 * The proxy keeps its own file-backed 90-day cache; this TTL sits in front
 * of it on Vercel and bounds how often the route re-reads the proxy. Keep it
 * in a plain module (not `route.ts`): Next's generated route types reject
 * extra exports besides the HTTP handlers and route config.
 */
const GC_NAME_CACHE_SECONDS = 3 * 24 * 60 * 60;

export default GC_NAME_CACHE_SECONDS;

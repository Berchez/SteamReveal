/**
 * Minimal CSRF guard for authenticated POST routes (watch/request, logout).
 *
 * The iron-session cookie is SameSite=Lax, which already blocks
 * third-party POSTs from sending it — this is the second layer: the
 * request's Origin (falling back to Referer) must match the request URL's
 * own origin. Fail closed: a missing/unparseable/mismatched origin is
 * rejected, because every legitimate caller is our own page (browsers
 * always send Origin on POST fetches). No token dance, no extra lib.
 *
 * Default export (single-export module, repo convention).
 */

const checkSameOrigin = (req: Request): boolean => {
  let target: URL;
  try {
    target = new URL(req.url);
  } catch {
    return false;
  }
  const claimed =
    req.headers.get('origin') ?? req.headers.get('referer') ?? null;
  if (claimed === null) return false;
  let source: URL;
  try {
    source = new URL(claimed);
  } catch {
    return false;
  }
  return source.protocol === target.protocol && source.host === target.host;
};

export default checkSameOrigin;

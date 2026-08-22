/**
 * Wraps `await req.json()` so a malformed/empty body (SyntaxError from
 * JSON.parse) is distinguishable from a real internal failure. Every
 * route's outer catch treats any thrown error the same way (500), which
 * made a client sending broken JSON look identical to an actual bug —
 * this lets each route check `error instanceof SyntaxError` before
 * falling back to 500.
 */
export default async function parseJsonBody<T = unknown>(
  req: Request,
): Promise<T> {
  return req.json() as Promise<T>;
}

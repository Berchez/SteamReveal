/**
 * Pure transient-infrastructure classifiers — the SINGLE source of truth
 * for "the backend is sick, retry/skip" across the repo (no imports, so
 * both Node scripts and the edge-safe lib graph can use it without pulling
 * the Turso DAL or @libsql/client).
 *
 * Two predicates, deliberately split:
 * - `isTransportFailure` (narrow): the connection itself died (idle
 *   timeout, network blip, closed hrana session). The ONLY predicate that
 *   may drop the DAL's memoized client — on a dead connection the client
 *   is useless, so rebuilding is pure win.
 * - `isTransientInfraError` (wide): narrow OR Turso-backend sickness
 *   surfaced THROUGH a live transport (Oct 2026 incident): diskless-WAL
 *   `S3 error ... code=5xx` listings and hrana HTTP 5xx. For
 *   classify/log/skip decisions only — never for client reset, because
 *   there the connection is healthy and dropping it just adds reconnect
 *   churn (plus an unclosed socket) on top of a sick backend.
 *
 * Both require an explicit 5xx signal for backend shapes. Verified against
 * the installed @libsql/client 0.18.0: `LibsqlError` prefixes the message
 * with its code (`SERVER_ERROR: ...`), and the hrana HTTP transport throws
 * `HttpServerError("Server returned HTTP status NNN")` for ANY non-2xx —
 * so a bare `SERVER_ERROR` also matches 401/403/404 (revoked token, wrong
 * URL, deleted database). Those are auth/config, must stay loud (smoke
 * FAIL, bot error), never skip/warn-quiet.
 *
 * Deliberately NOT matched by either: schema drift (`no such table`, `has
 * no column named ...`) and logic errors — those must stay loud (migrate
 * hint, 500).
 */
const CONNECTION_FAILURE_PATTERN =
  /(?:connection|socket|session is closed|ECONNRESET|ECONNREFUSED|network|fetch failed|timeout|timed out)/i;

const TURSO_BACKEND_5XX_PATTERN =
  /(?:S3 error.*\bcode=5\d\d|HTTP status 5\d\d)/i;

export const isTransportFailure = (error: unknown): boolean =>
  error instanceof Error && CONNECTION_FAILURE_PATTERN.test(error.message);

export const isTransientInfraError = (error: unknown): boolean =>
  error instanceof Error &&
  (CONNECTION_FAILURE_PATTERN.test(error.message) ||
    TURSO_BACKEND_5XX_PATTERN.test(error.message));

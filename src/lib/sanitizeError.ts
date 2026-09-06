/**
 * Redacts credentials and connection strings from error messages before they
 * are logged or returned over HTTP. The Turso/libSQL driver can embed the
 * full URL (and its auth token) inside `err.message`; anything that reaches a
 * terminal or a response body must be scrubbed first.
 *
 * Beyond `token=`/`token:` literals (the historical patterns) this also
 * catches quoted tokens (`token '...'`), bare tokens after whitespace, and
 * JWT-shaped strings, so a differently-formatted driver message still can't
 * leak a credential.
 *
 * The optional `auth[_-]?` prefix matters: driver messages refer to the
 * credential as `authToken`/`auth_token` (libSQL) or `authtoken`, not the
 * bare word `token`, so an unconditional `\btoken` would miss them (word
 * boundary exists before `auth`, not before `token`).
 */

const TOKEN_LITERAL_PATTERN = /\b(?:auth[_-]?)?token[=:]\s*\S+/gi;
const TOKEN_BARE_OR_QUOTED_PATTERN = /\b(?:auth[_-]?)?token\s+["']?[A-Za-z0-9._-]+["']?/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){1,2}\b/g;
const LIB_SQL_URL_PATTERN = /libsql:\/\/\S+/g;
const DATABASE_URL_PATTERN = /\b(?:libsql|https?):\/\/[^\s"']+/gi;

export const sanitizeError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);

  return raw
    .replace(TOKEN_LITERAL_PATTERN, 'token=[REDACTED]')
    .replace(TOKEN_BARE_OR_QUOTED_PATTERN, 'token=[REDACTED]')
    .replace(JWT_PATTERN, '[JWT REDACTED]')
    .replace(LIB_SQL_URL_PATTERN, 'libsql://[REDACTED]')
    .replace(DATABASE_URL_PATTERN, '[URL REDACTED]');
};

export default sanitizeError;
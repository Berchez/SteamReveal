/**
 * Redacts credentials and connection strings from error messages before they
 * are logged or returned over HTTP. The Turso/libSQL driver can embed the
 * full URL (and its auth token) inside `err.message`; anything that reaches a
 * terminal or a response body must be scrubbed first.
 *
 * Beyond `token=`/`token:` literals (the historical patterns) this also
 * catches quoted tokens (`token '...'`), bare tokens after whitespace,
 * JWT-shaped strings, `*key=` query secrets (Steam Web API `key=`, ...),
 * and `authorization:` headers, so a differently-formatted driver message
 * still can't leak a credential.
 *
 * The `\w*` prefixes matter: secrets arrive as `authToken`/`auth_token`
 * (libSQL), `authtoken`, `anti_loop_token=` (bot links), `api_key=`,
 * `apiKey=` — an unconditional `\btoken`/`\bkey` would miss them (no word
 * boundary inside `anti_loop_token`). Fail-closed on purpose: a benign
 * `monkey=banana` also redacts. That is the right trade for error logs —
 * and for HTTP error bodies, which share this function.
 *
 * Redaction is by secret NAME in two delimiter styles, because nested
 * context objects reach this function via `JSON.stringify` (quotes around
 * the key, colon delimiter: `{"token":"..."}` — the `=`-anchored patterns
 * above cannot see those). The name list covers this repo's real secrets:
 * tokens, keys, passwords, session/cookie/clearance values, auth headers.
 * Deliberate boundary: bare prose with no delimiter (`my password is x`)
 * and non-string JSON values stay untouched — indistinguishable from
 * English without an allowlist, which error text cannot provide.
 */

const SECRET_NAME = String.raw`password|passwd|secret|token|key|auth|authorization|cookie|session|clearance`;
const TOKEN_LITERAL_PATTERN = /\b(\w*token)[=:]\s*\S+/gi;
// Bare form only fires on opaque-looking values (contains a digit or
// underscore, or 12+ chars): plain-English `token rolled back` / `token
// expired` (bot incident lines, diagnostics) must survive in the file log,
// while `token abc123XYZ_` still redacts.
const TOKEN_BARE_OR_QUOTED_PATTERN =
  /\b(?:auth[_-]?)?token\s+["']?(?:[A-Za-z0-9._-]*[0-9_][A-Za-z0-9._-]*|[A-Za-z0-9._-]{12,})["']?/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){1,2}\b/g;
const API_KEY_PATTERN = /\b(\w*key)[=:]\s*\S+/gi;
const AUTH_HEADER_PATTERN = /\b(authorization)[:=]\s*(?:Bearer\s+)?\S+/gi;
// `name=value` for the remaining secret names (passwords, sessions,
// cookies, clearance values — the token/key/auth shapes above already
// cover theirs). The key name is preserved so the line stays diagnosable.
const SECRET_LITERAL_PATTERN = new RegExp(
  `\\b(\\w*(?:${SECRET_NAME}))\\s*[=:]\\s*\\S+`,
  'gi',
);
// `"name": "value"` — the JSON.stringify form nested context takes.
// Value must be a quoted string (a null/number/bool carries no secret).
const JSON_SECRET_PATTERN = new RegExp(
  `"((?:\\w*(?:${SECRET_NAME})\\w*))"\\s*:\\s*"[^"]*"`,
  'gi',
);
const LIB_SQL_URL_PATTERN = /libsql:\/\/\S+/g;
const DATABASE_URL_PATTERN = /\b(?:libsql|https?):\/\/[^\s"']+/gi;

export const sanitizeError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);

  // The literal/name patterns preserve the matched field name ($1) so
  // log lines stay diagnosable (`sessionKey=` → `sessionKey=[REDACTED]`,
  // not a bare `key=`): which field leaked matters as much as the fact.
  return raw
    .replace(TOKEN_LITERAL_PATTERN, '$1=[REDACTED]')
    .replace(TOKEN_BARE_OR_QUOTED_PATTERN, 'token=[REDACTED]')
    .replace(JWT_PATTERN, '[JWT REDACTED]')
    .replace(API_KEY_PATTERN, '$1=[REDACTED]')
    .replace(AUTH_HEADER_PATTERN, '$1=[REDACTED]')
    .replace(SECRET_LITERAL_PATTERN, '$1=[REDACTED]')
    .replace(JSON_SECRET_PATTERN, '"$1":"[REDACTED]"')
    .replace(LIB_SQL_URL_PATTERN, 'libsql://[REDACTED]')
    .replace(DATABASE_URL_PATTERN, '[URL REDACTED]');
};

export default sanitizeError;
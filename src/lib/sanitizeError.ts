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

// Bare form only fires on opaque-looking values (contains a digit or
// underscore, or 12+ chars): plain-English `token rolled back` / `token
// expired` (bot incident lines, diagnostics) must survive in the file log,
// while `token abc123XYZ_` still redacts.
const TOKEN_BARE_OR_QUOTED_PATTERN =
  /\b(?:auth[_-]?)?token\s+["']?(?:[A-Za-z0-9._-]*[0-9_][A-Za-z0-9._-]*|[A-Za-z0-9._-]{12,})["']?/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){1,2}\b/g;
const AUTH_HEADER_PATTERN = /\b(authorization)[:=]\s*(?:Bearer\s+)?\S+/gi;
// `name=value` for every secret name in one pattern (this subsumes the old
// dedicated token/key literals: same match shape, same $1-preserving
// replacement — one surface to maintain instead of three). The key name is
// preserved so the line stays diagnosable.
const SECRET_LITERAL_PATTERN = new RegExp(
  `\\b(\\w*(?:${SECRET_NAME}))\\s*[=:]\\s*\\S+`,
  'gi',
);
// `"name": "value"` — the JSON.stringify form nested context takes.
// Suffix-only (the name must END at the closing quote): real secret keys
// end with the kind (`apiKey`, `authToken`, `SESSION_SECRET`), while
// `sessionType`/`authorName`/`cookieBanner` merely contain it mid-word and
// stay readable. `"monkey"` still redacts (ends with `key`) — accepted
// residual, documented in the tests. Value must be a quoted string (a
// null/number/bool carries no secret).
const JSON_SECRET_PATTERN = new RegExp(
  `"((?:\\w*(?:${SECRET_NAME})))"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`,
  'gi',
);
// Escaped-JSON twin of the pattern above, DERIVED (not hand-escaped):
// every structural quote of the proven source gains one literal
// backslash, so backslash-quote spans match. Same suffix rule, same
// quoted-value requirement, same $1-preserving style. Derivation (not
// duplication) keeps the two in lockstep by construction.
const ESC_BS = String.fromCharCode(92);
/**
 * Prefixes every STRUCTURAL double-quote of a pattern source with a
 * literal backslash, turning a plain-JSON matcher into its
 * backslash-escaped twin (`"name":"v"` also matches `\"name\":\"v\"`).
 * Escape pairs (`\\`, `\"`, ...) pass through untouched, and quotes
 * inside `[...]` classes are left alone (prefixing them is harmless but
 * pointless — and this explicit walk, not a blind split/join, is what
 * keeps a future edit adding quotes inside a class from silently
 * changing behavior). Input contract: pattern sources in this file's
 * style (no `\"` outside escape pairs).
 */
export const escapeStructuralQuotes = (source: string): string => {
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ESC_BS) {
      out += ch + (source[i + 1] ?? '');
      i += 2;
    } else {
      if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth = Math.max(0, depth - 1);
      }
      if (ch === '"' && depth === 0) {
        out += `${ESC_BS}${ESC_BS}"`;
      } else {
        out += ch;
      }
      i += 1;
    }
  }
  return out;
};

const JSON_ESCAPED_SECRET_PATTERN = new RegExp(
  escapeStructuralQuotes(JSON_SECRET_PATTERN.source),
  'gi',
);
const JSON_ESCAPED_REPLACEMENT =
  `${ESC_BS}"$1${ESC_BS}":${ESC_BS}"[REDACTED]${ESC_BS}"`;
const LIB_SQL_URL_PATTERN = /libsql:\/\/\S+/g;
const DATABASE_URL_PATTERN = /\b(?:libsql|https?):\/\/[^\s"']+/gi;

export const sanitizeError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);

  // The literal/name patterns preserve the matched field name ($1) so
  // log lines stay diagnosable (`sessionKey=` → `sessionKey=[REDACTED]`,
  // not a bare `key=`): which field leaked matters as much as the fact.
  return raw
    .replace(TOKEN_BARE_OR_QUOTED_PATTERN, 'token=[REDACTED]')
    .replace(JWT_PATTERN, '[JWT REDACTED]')
    .replace(AUTH_HEADER_PATTERN, '$1=[REDACTED]')
    .replace(SECRET_LITERAL_PATTERN, '$1=[REDACTED]')
    .replace(JSON_SECRET_PATTERN, '"$1":"[REDACTED]"')
    .replace(JSON_ESCAPED_SECRET_PATTERN, JSON_ESCAPED_REPLACEMENT)
    .replace(LIB_SQL_URL_PATTERN, 'libsql://[REDACTED]')
    .replace(DATABASE_URL_PATTERN, '[URL REDACTED]');
};

export default sanitizeError;
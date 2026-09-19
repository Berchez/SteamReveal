import { sanitizeError } from './sanitizeError';

describe('sanitizeError', () => {
  it('redacts token= and token: literals', () => {
    expect(sanitizeError(new Error('auth failed token=supersecret'))).toBe(
      'auth failed token=[REDACTED]',
    );
    expect(sanitizeError('token:eyJhbc== boom')).toBe(
      'token=[REDACTED] boom',
    );
  });

  it('redacts quoted and bare tokens after the word token', () => {
    expect(
      sanitizeError(new Error("Invalid token 'eyJhbGciOiJIUzI1NiJ9.sig'")),
    ).toBe('Invalid token=[REDACTED]');
    expect(sanitizeError('Unauthorized token abc123XYZ_')).toBe(
      'Unauthorized token=[REDACTED]',
    );
  });

  it('leaves plain-English token phrases intact (bot incident lines stay greppable)', () => {
    // `token` + short alpha word = prose, not a secret (opaque values
    // carry digits/underscores or length). The file log must keep these
    // readable — the runbook greps them.
    expect(sanitizeError('issued token rolled back, retry')).toBe(
      'issued token rolled back, retry',
    );
    expect(sanitizeError('token rollback failed')).toBe(
      'token rollback failed',
    );
    expect(sanitizeError('token expired, retry')).toBe('token expired, retry');
  });

  it('redacts standalone JWT-shaped strings anywhere in the message', () => {
    expect(
      sanitizeError(
        'connect rejected, credential eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig is bad',
      ),
    ).toBe('connect rejected, credential [JWT REDACTED] is bad');
  });

  it('redacts libsql:// connection strings and other db URLs', () => {
    expect(
      sanitizeError('failed to open libsql://steamreveal-user:tok@host.turso.io:8080'),
    ).toBe('failed to open [URL REDACTED]');
    expect(sanitizeError('bad url https://user:pass@example.com/x')).toBe(
      'bad url [URL REDACTED]',
    );
  });

  it('redacts libsql:// even without a preceding word boundary', () => {
    // No \b before "libsql" here — the generic DATABASE_URL_PATTERN can't
    // match it; this is what LIB_SQL_URL_PATTERN exists for.
    expect(
      sanitizeError('embeddedurlxlibsql://user:tok@host.turso.io seeded'),
    ).toBe('embeddedurlxlibsql://[REDACTED] seeded');
  });

  it('redacts authToken/auth_token variants the drivers actually use', () => {
    expect(
      sanitizeError('connect error invalid authToken topsecret123XYZ'),
    ).toBe('connect error invalid token=[REDACTED]');
    expect(sanitizeError("refused auth_token 'abc123XYZ'")).toBe(
      'refused token=[REDACTED]',
    );
    expect(sanitizeError('bad credentials authtoken=sup3r-secret')).toBe(
      'bad credentials authtoken=[REDACTED]',
    );
  });

  it('leaves ordinary messages untouched', () => {
    expect(sanitizeError(new Error('Rate limit exceeded'))).toBe(
      'Rate limit exceeded',
    );
    expect(sanitizeError('plain string')).toBe('plain string');
  });

  it('redacts bot confirm-link and anti-loop token shapes (real link forms)', () => {
    const hex64 = 'a'.repeat(64);
    // Bare query shape (no scheme): the token pattern does the work and
    // the surrounding text survives.
    expect(sanitizeError(`open confirm?token=${hex64} now`)).toBe(
      'open confirm?token=[REDACTED] now',
    );
    // anti_loop_token= has no word boundary before "token" — the \w*
    // prefix exists exactly for this shape.
    const antiLoop = sanitizeError(
      `see /en/player/1?anti_loop_token=${hex64} end`,
    );
    expect(antiLoop).not.toContain(hex64);
    expect(antiLoop).toContain('token=[REDACTED]');
    // Full https URLs are eaten whole by the URL pattern (even stronger).
    expect(
      sanitizeError(`open https://site/api/watch/confirm?token=${hex64} now`),
    ).toBe('open [URL REDACTED] now');
  });

  it('preserves the field-name prefix so redacted lines stay diagnosable', () => {
    expect(sanitizeError('call failed sessionKey=abc123XYZ')).toBe(
      'call failed sessionKey=[REDACTED]',
    );
    expect(sanitizeError('call failed api_key=abc123XYZ')).toBe(
      'call failed api_key=[REDACTED]',
    );
  });

  it('redacts Steam-style key= secrets but keeps neighboring steamIds', () => {
    const apiKey = 'b'.repeat(32);
    const redacted = sanitizeError(
      `steam call failed key=${apiKey} for steamId=76561198000000001`,
    );
    expect(redacted).not.toContain(apiKey);
    expect(redacted).toContain('key=[REDACTED]');
    // steamId= carries no secret (searchable public id) and must survive
    // for the log line to stay diagnosable.
    expect(redacted).toContain('steamId=76561198000000001');
  });

  it('redacts authorization headers including the Bearer scheme', () => {
    expect(
      sanitizeError('rejected authorization: Bearer abc123XYZ tail'),
    ).toBe('rejected authorization=[REDACTED] tail');
  });

  it('does not redact words that merely contain key without a secret', () => {
    expect(sanitizeError('monkey business as usual')).toBe(
      'monkey business as usual',
    );
    expect(sanitizeError('profile key check passed')).toBe(
      'profile key check passed',
    );
  });

  it('redacts secret names in JSON-quoted form (nested stringified context)', () => {
    // flattenContext stringifies nested objects, so the key arrives quoted
    // with a colon — invisible to the =-anchored patterns above. The key
    // name is preserved so the line stays diagnosable.
    expect(sanitizeError('body={"token":"a1b2c3d4"} end')).toBe(
      'body={"token":"[REDACTED]"} end',
    );
    expect(sanitizeError('params={"apiKey":"zzz999"}')).toBe(
      'params={"apiKey":"[REDACTED]"}',
    );
    expect(sanitizeError('headers={"authorization":"Bearer abc"} done')).toBe(
      'headers={"authorization":"[REDACTED]"} done',
    );
    expect(sanitizeError('cfg={"session":"deadbeef"}')).toBe(
      'cfg={"session":"[REDACTED]"}',
    );
    // Non-string JSON values carry no secret and stay untouched.
    expect(sanitizeError('opts={"retries":3}')).toBe('opts={"retries":3}');
  });

  it('redacts password/secret/cookie/session/clearance in literal form', () => {
    expect(sanitizeError('login failed password=s3cr3t!')).toBe(
      'login failed password=[REDACTED]',
    );
    expect(sanitizeError('SESSION_SECRET=deadbeef cfg')).toBe(
      'SESSION_SECRET=[REDACTED] cfg',
    );
    expect(sanitizeError('set cookie: abc123')).toBe(
      'set cookie=[REDACTED]',
    );
    expect(sanitizeError('cf_clearance=abc123 blocked')).toBe(
      'cf_clearance=[REDACTED] blocked',
    );
  });

  it('leaves benign JSON keys and bare prose untouched (documented boundary)', () => {
    expect(sanitizeError('data={"nickname":"fred","steamId":"1"}')).toBe(
      'data={"nickname":"fred","steamId":"1"}',
    );
    expect(sanitizeError('session expired, retry')).toBe(
      'session expired, retry',
    );
  });
});

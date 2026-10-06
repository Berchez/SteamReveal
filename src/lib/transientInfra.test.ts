import { isTransientInfraError, isTransportFailure } from './transientInfra';

describe('isTransientInfraError (infra blip vs must-stay-loud)', () => {
  it('matches transport death (fetch failed, timeouts, sockets)', () => {
    expect(isTransientInfraError(new Error('fetch failed'))).toBe(true);
    expect(isTransientInfraError(new Error('connection is closed'))).toBe(
      true,
    );
    expect(isTransientInfraError(new Error('request timed out'))).toBe(true);
    expect(isTransientInfraError(new Error('socket hang up'))).toBe(true);
  });

  it('matches Turso-backend sickness through a live transport', () => {
    expect(
      isTransientInfraError(
        new Error(
          'S3 error: failed to list objects in S3 storage: bucket=turso-diskless-wal-bucket--use1-az4--x-s3, code=500',
        ),
      ),
    ).toBe(true);
    expect(
      isTransientInfraError(
        new Error('SERVER_ERROR: Server returned HTTP status 502'),
      ),
    ).toBe(true);
    expect(
      isTransientInfraError(new Error('Server returned HTTP status 503')),
    ).toBe(true);
  });

  it('never throws on non-Error garbage and returns false', () => {
    const values: unknown[] = [
      undefined,
      null,
      42,
      'fetch failed',
      'S3 error',
      {},
      Object.create(null),
    ];
    for (const value of values) {
      expect(() => isTransientInfraError(value)).not.toThrow();
      expect(isTransientInfraError(value)).toBe(false);
    }
  });

  it('keeps schema drift loud (the Sep 2026 incident strings)', () => {
    expect(
      isTransientInfraError(
        new Error(
          'Analytics database schema is missing — run `pnpm run db:migrate` first. (Original DB error: SQLITE_UNKNOWN: SQLite error: table bot_heartbeat has no column named disconnected_since)',
        ),
      ),
    ).toBe(false);
    expect(
      isTransientInfraError(
        new Error(
          'Analytics database schema is missing — run `pnpm run db:migrate` first. (Original DB error: SQLITE_UNKNOWN: SQLite error: no such table: ban_watch_targets)',
        ),
      ),
    ).toBe(false);
    expect(
      isTransientInfraError(
        new Error(
          'SQLITE_UNKNOWN: SQLite error: table search_meta has no column named friends_visibility',
        ),
      ),
    ).toBe(false);
  });

  it('keeps logic/auth failures loud', () => {
    expect(isTransientInfraError(new Error('dropped after 3 attempts'))).toBe(
      false,
    );
    expect(isTransientInfraError(new Error('Unauthorized'))).toBe(false);
    expect(isTransientInfraError(new Error('Invalid token'))).toBe(false);
  });

  it('keeps hrana HTTP 4xx loud (revoked token, wrong URL, deleted DB)', () => {
    // Verified shape against @libsql/client 0.18.0: `LibsqlError` prefixes
    // `${code}: ` and the hrana transport throws HttpServerError for ANY
    // non-2xx — so a bare `SERVER_ERROR` prefix MUST NOT imply transient.
    expect(
      isTransientInfraError(
        new Error('SERVER_ERROR: Server returned HTTP status 401'),
      ),
    ).toBe(false);
    expect(
      isTransientInfraError(
        new Error('SERVER_ERROR: Server returned HTTP status 403'),
      ),
    ).toBe(false);
    expect(
      isTransientInfraError(
        new Error('SERVER_ERROR: Server returned HTTP status 404'),
      ),
    ).toBe(false);
    expect(
      isTransientInfraError(
        new Error(
          'SERVER_ERROR: Server returned HTTP status 401: Unauthorized',
        ),
      ),
    ).toBe(false);
  });

  it('keeps non-5xx S3 failures loud', () => {
    expect(
      isTransientInfraError(new Error('S3 error: access denied, code=403')),
    ).toBe(false);
  });

  it('isTransportFailure stays narrow (connection death only)', () => {
    // The DAL memo-drop contract: only a dead connection discards the
    // memoized client. Backend 5xx through a live transport must NOT reset
    // it (healthy connection, sick backend — dropping adds reconnect churn
    // plus an unclosed socket per failure).
    expect(isTransportFailure(new Error('fetch failed'))).toBe(true);
    expect(isTransportFailure(new Error('connection is closed'))).toBe(true);
    expect(
      isTransportFailure(
        new Error('SERVER_ERROR: Server returned HTTP status 502'),
      ),
    ).toBe(false);
    expect(
      isTransportFailure(new Error('S3 error: failed to list objects, code=500')),
    ).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });
});

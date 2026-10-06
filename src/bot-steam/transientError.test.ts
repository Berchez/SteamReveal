import {
  isBotTransientError,
  logBotPassError,
  markBotPassHealthy,
  resetBotPassErrorCountsForTests,
} from './transientError';

describe('isBotTransientError (infra blip vs logic bug)', () => {
  it('matches transport failures (fetch failed, timeouts, sockets)', () => {
    expect(isBotTransientError(new Error('fetch failed'))).toBe(true);
    expect(
      isBotTransientError(new Error('connection is closed')),
    ).toBe(true);
    expect(isBotTransientError(new Error('request timed out'))).toBe(true);
  });

  it('matches Turso-side 5xx/S3 surfaces from the ops log', () => {
    expect(
      isBotTransientError(
        new Error(
          'S3 error: failed to list objects in S3 storage: bucket=turso-diskless-wal-bucket, code=500',
        ),
      ),
    ).toBe(true);
    expect(
      isBotTransientError(
        new Error('SERVER_ERROR: Server returned HTTP status 502'),
      ),
    ).toBe(true);
    expect(
      isBotTransientError(new Error('Server returned HTTP status 503')),
    ).toBe(true);
  });

  it('matches Steam session flaps owned by the reconnect loop', () => {
    expect(
      isBotTransientError(new Error('client error (NoConnection(3))')),
    ).toBe(true);
    expect(
      isBotTransientError(new Error('client error (ServiceUnavailable(20))')),
    ).toBe(true);
  });

  it('never throws on non-Error garbage and returns false', () => {
    const values: unknown[] = [
      undefined,
      null,
      42,
      'fetch failed',
      'NoConnection',
      {},
      Object.create(null),
    ];
    for (const value of values) {
      expect(() => isBotTransientError(value)).not.toThrow();
      expect(isBotTransientError(value)).toBe(false);
    }
  });

  it('keeps genuine failures out of the warn lane', () => {
    expect(isBotTransientError(new Error('dropped after 3 attempts'))).toBe(
      false,
    );
    expect(isBotTransientError(new Error('Bad Request'))).toBe(false);
    expect(isBotTransientError(new Error('Unauthorized'))).toBe(false);
  });

  it('keeps schema drift loud (the Sep 2026 incident strings)', () => {
    expect(
      isBotTransientError(
        new Error(
          'Analytics database schema is missing — run `pnpm run db:migrate` first. (Original DB error: SQLITE_UNKNOWN: SQLite error: table bot_heartbeat has no column named disconnected_since)',
        ),
      ),
    ).toBe(false);
    expect(
      isBotTransientError(
        new Error(
          'Analytics database schema is missing — run `pnpm run db:migrate` first. (Original DB error: SQLITE_UNKNOWN: SQLite error: no such table: ban_watch_targets)',
        ),
      ),
    ).toBe(false);
  });
});

describe('logBotPassError (warn vs error routing)', () => {
  const makeLogger = () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  });

  beforeEach(() => {
    resetBotPassErrorCountsForTests();
  });

  it('routes transient infra to warn with the same line shape', () => {
    const logger = makeLogger();
    logBotPassError(logger, 'invite poll pass failed', new Error('fetch failed'));
    expect(logger.warn).toHaveBeenCalledWith(
      '[WatchBot] invite poll pass failed: fetch failed',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('routes logic failures to error', () => {
    const logger = makeLogger();
    logBotPassError(logger, 'invite poll pass failed', new Error('dropped after 3 attempts'));
    expect(logger.error).toHaveBeenCalledWith(
      '[WatchBot] invite poll pass failed: dropped after 3 attempts',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to info when the logger has no warn (old doubles)', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    expect(() =>
      logBotPassError(logger, 'welcome poll pass failed', new Error('fetch failed')),
    ).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith(
      '[WatchBot] welcome poll pass failed: fetch failed',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('escalates to error after sustained transient failures of one lane', () => {
    const logger = makeLogger();
    const label = 'escalation-probe-lane';
    for (let i = 0; i < 4; i += 1) {
      logBotPassError(logger, label, new Error('fetch failed'));
    }
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.error).not.toHaveBeenCalled();

    logBotPassError(logger, label, new Error('fetch failed'));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('escalated'),
    );
  });

  it('never escalates a flapping lane (success resets the streak)', () => {
    // Windowed counting escalated fail/ok/fail patterns without the lane
    // being sick; consecutive counting with reset does not.
    const logger = makeLogger();
    const label = 'flapping-lane';
    for (let i = 0; i < 10; i += 1) {
      logBotPassError(logger, label, new Error('fetch failed'));
      markBotPassHealthy(label);
    }
    expect(logger.warn).toHaveBeenCalledTimes(10);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a success mid-streak restarts the escalation count', () => {
    const logger = makeLogger();
    const label = 'recovering-lane';
    for (let i = 0; i < 4; i += 1) {
      logBotPassError(logger, label, new Error('fetch failed'));
    }
    markBotPassHealthy(label);
    for (let i = 0; i < 4; i += 1) {
      logBotPassError(logger, label, new Error('fetch failed'));
    }
    // 4 + reset + 4: never 5 consecutive, so still warn-only.
    expect(logger.warn).toHaveBeenCalledTimes(8);
    expect(logger.error).not.toHaveBeenCalled();

    logBotPassError(logger, label, new Error('fetch failed'));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('escalated'),
    );
  });

  it('tracks lanes independently (one stuck lane does not escalate another)', () => {
    const logger = makeLogger();
    for (let i = 0; i < 4; i += 1) {
      logBotPassError(logger, 'stuck-lane', new Error('fetch failed'));
    }
    logBotPassError(logger, 'healthy-lane', new Error('fetch failed'));
    expect(logger.warn).toHaveBeenCalledWith(
      '[WatchBot] healthy-lane: fetch failed',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('never throws on unprintable errors (null-prototype String that throws)', () => {
    const logger = makeLogger();
    const evil = Object.create(null);
    // String(evil) throws — the detail renderer must not turn a .catch
    // driver into an unhandled rejection. (Non-Errors route to error
    // here: not transient, but at least logged safely.)
    expect(() => logBotPassError(logger, 'evil-lane', evil)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      '[WatchBot] evil-lane: [unprintable error]',
    );
  });
});

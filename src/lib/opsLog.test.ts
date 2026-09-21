/**
 * @jest-environment node
 */

// File-system integration tests (tmpdir): jsdom buys nothing here and
// node keeps process/fs semantics exact.
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeOpsLog,
  clearOpsLogFsDisabled,
  resetOpsLogRuntimeState,
  truncateString,
  installCrashHandlers,
  formatOpsLine,
  flattenContext,
  dayFileName,
  isLogFileExpired,
  trimToTailBytes,
  shouldRolloverFile,
  resolveOpsLogDir,
  resolveRetentionDays,
  ERRORS_TRIM_TRIGGER_BYTES,
  ERRORS_TRIM_TARGET_BYTES,
} from './opsLog';

const FIXED_NOW = Date.parse('2026-09-19T14:22:03.512Z');

describe('opsLog pure pieces', () => {
  it('formats the bracketed-timestamp line with flat context', () => {
    expect(
      formatOpsLine('site', 'error', 'boom', { steamId: '765', n: 2 }, FIXED_NOW),
    ).toBe(
      '[2026-09-19T14:22:03.512Z] [site] ERROR: boom | steamId=765 n=2',
    );
  });

  it('omits the context segment when there is none', () => {
    expect(formatOpsLine('bot', 'info', 'hello', undefined, FIXED_NOW)).toBe(
      '[2026-09-19T14:22:03.512Z] [bot] INFO: hello',
    );
    expect(formatOpsLine('bot', 'info', 'hello', {}, FIXED_NOW)).toBe(
      '[2026-09-19T14:22:03.512Z] [bot] INFO: hello',
    );
  });

  it('strips terminal control characters (no log injection via user input)', () => {
    // ESC sequences smuggled in via user-controlled fields (e.g. a proxy
    // steamId) must die here: these lines are tailed straight into
    // terminals, where \x1b[2J would execute.
    const line = formatOpsLine(
      'proxy-local',
      'error',
      'scrape failed',
      { steamId: '765\x1b[2J' },
      FIXED_NOW,
    );
    expect(line).not.toContain('\x1b');
    expect(line).toContain('steamId=765 ');
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('keeps one event on exactly one file line', () => {
    const line = formatOpsLine(
      'bot',
      'error',
      'first\nsecond\r\nthird',
      { stack: 'a\nb' },
      FIXED_NOW,
    );
    expect(line).not.toContain('\n');
    expect(line).toContain('first second third');
  });

  it('sanitizes at the boundary (raw upstream errors must not reach disk)', () => {
    const line = formatOpsLine(
      'site',
      'error',
      'query failed authToken=secret123',
      { target: 'libsql://db-org.turso.io' },
      FIXED_NOW,
    );
    expect(line).not.toContain('secret123');
    expect(line).not.toContain('db-org.turso.io');
    expect(line).toContain('authToken=[REDACTED]');
    // sanitizeError's own composition (pre-existing): its DATABASE_URL
    // pattern also matches the libsql redaction marker, converging to
    // [URL REDACTED] — still leak-free, just a different marker.
    expect(line).toContain('[URL REDACTED]');
  });

  it('re-sanitizing already-redacted text is a fixed point', () => {
    const once = formatOpsLine('site', 'error', 'x authToken=s', undefined, FIXED_NOW);
    const twice = formatOpsLine(
      'site',
      'error',
      once.slice(once.indexOf(': ') + 2),
      undefined,
      FIXED_NOW,
    );
    expect(twice).toContain('authToken=[REDACTED]');
    expect(twice).not.toContain('authToken=s');
  });

  it('flattens nested and circular context without throwing', () => {
    expect(flattenContext(undefined)).toBe('');
    expect(flattenContext({})).toBe('');
    expect(
      flattenContext({ a: 1, b: true, c: null, d: undefined, e: { x: [1] } }),
    ).toBe(' | a=1 b=true c=null d=undefined e={"x":[1]}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(flattenContext({ c: circular })).toBe(' | c=[unserializable]');
  });

  it('names day files per service per UTC day, safely', () => {
    expect(dayFileName('bot', FIXED_NOW)).toBe('bot-2026-09-19.log');
    expect(dayFileName('../evil', FIXED_NOW)).not.toContain('/');
    expect(dayFileName('../evil', FIXED_NOW)).toMatch(/\.log$/);
  });

  it('expires only matching day files past the retention window', () => {
    // 20 days back with a 14-day window: expired.
    expect(
      isLogFileExpired('bot-2026-08-30.log', 'bot', 14, FIXED_NOW),
    ).toBe(true);
    // Today and yesterday: kept.
    expect(isLogFileExpired('bot-2026-09-19.log', 'bot', 14, FIXED_NOW)).toBe(
      false,
    );
    expect(isLogFileExpired('bot-2026-09-18.log', 'bot', 14, FIXED_NOW)).toBe(
      false,
    );
    // Rollover sidecars follow the same rule.
    expect(
      isLogFileExpired('bot-2026-08-30.1.log', 'bot', 14, FIXED_NOW),
    ).toBe(true);
    // Never expire what we do not own: the combined file, other services,
    // malformed names.
    expect(isLogFileExpired('errors.log', 'bot', 14, FIXED_NOW)).toBe(false);
    expect(
      isLogFileExpired('proxy-local-2026-08-30.log', 'bot', 14, FIXED_NOW),
    ).toBe(false);
    expect(isLogFileExpired('bot-yesterday.log', 'bot', 14, FIXED_NOW)).toBe(
      false,
    );
    expect(isLogFileExpired('bot-2026-13-99.log', 'bot', 14, FIXED_NOW)).toBe(
      false,
    );
  });

  it('truncates long strings with a marker, leaves short ones alone', () => {
    expect(truncateString('abc', 10)).toBe('abc');
    expect(truncateString('abcdefghij', 10)).toBe('abcdefghij');
    expect(truncateString('abcdefghijk', 10)).toBe('abcdefghij...[truncated]');
  });

  it('trims to a byte tail cut on a line boundary', () => {
    expect(trimToTailBytes('', 100)).toBe('');
    // Under budget: byte-identical, no rewrite.
    expect(trimToTailBytes('a\nb\n', 100)).toBe('a\nb\n');
    // Over budget: keeps complete trailing lines only (no torn head).
    expect(trimToTailBytes('aaa\nbbb\nccc\n', 8)).toBe('ccc\n');
    expect(trimToTailBytes('aaa\nbbb\nccc\n', 9)).toBe('bbb\nccc\n');
    // No newline in budget window: nothing usable to keep.
    expect(trimToTailBytes('abcdefgh', 4)).toBe('');
  });

  it('rolls over at/above the size cap only', () => {
    expect(shouldRolloverFile(0)).toBe(false);
    expect(shouldRolloverFile(10 * 1024 * 1024 - 1)).toBe(false);
    expect(shouldRolloverFile(10 * 1024 * 1024)).toBe(true);
    expect(shouldRolloverFile(10 * 1024 * 1024, 10)).toBe(true);
  });

  it('resolves dir and retention from env with safe defaults', () => {
    const savedDir = process.env.OPS_LOG_DIR;
    const savedRetention = process.env.OPS_LOG_RETENTION_DAYS;
    try {
      delete process.env.OPS_LOG_DIR;
      delete process.env.OPS_LOG_RETENTION_DAYS;
      expect(resolveOpsLogDir()).toBe(
        path.join(process.cwd(), '.data', 'logs'),
      );
      expect(resolveRetentionDays()).toBe(14);
      process.env.OPS_LOG_DIR = '/tmp/x';
      process.env.OPS_LOG_RETENTION_DAYS = '30';
      expect(resolveOpsLogDir()).toBe('/tmp/x');
      expect(resolveRetentionDays()).toBe(30);
      // Empty string falls back too (same || semantics as the tail script —
      // ?? would diverge here).
      process.env.OPS_LOG_DIR = '';
      expect(resolveOpsLogDir()).toBe(
        path.join(process.cwd(), '.data', 'logs'),
      );
      process.env.OPS_LOG_RETENTION_DAYS = 'garbage';
      expect(resolveRetentionDays()).toBe(14);
      process.env.OPS_LOG_RETENTION_DAYS = '-5';
      expect(resolveRetentionDays()).toBe(14);
    } finally {
      if (savedDir === undefined) delete process.env.OPS_LOG_DIR;
      else process.env.OPS_LOG_DIR = savedDir;
      if (savedRetention === undefined) {
        delete process.env.OPS_LOG_RETENTION_DAYS;
      } else {
        process.env.OPS_LOG_RETENTION_DAYS = savedRetention;
      }
    }
  });
});

describe('writeOpsLog file integration (tmpdir)', () => {
  let dir: string;
  let savedDir: string | undefined;

  beforeEach(() => {
    savedDir = process.env.OPS_LOG_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opslog-test-'));
    process.env.OPS_LOG_DIR = dir;
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.OPS_LOG_DIR;
    else process.env.OPS_LOG_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // Unique service names per test: the module tracks init state per
  // service, so sharing one would couple these tests to execution order.
  it('appends to the day file and mirrors errors into errors.log', () => {
    writeOpsLog('probe-append', 'error', 'kaboom', { steamId: '765' });
    writeOpsLog('probe-append', 'info', 'just fyi');

    const dayFiles = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('probe-append-') && f.endsWith('.log'));
    expect(dayFiles).toHaveLength(1);
    const dayContent = fs.readFileSync(path.join(dir, dayFiles[0]), 'utf8');
    expect(dayContent).toContain('[probe-append] ERROR: kaboom | steamId=765');
    expect(dayContent).toContain('[probe-append] INFO: just fyi');
    // Process boundary written once per service per process run.
    expect(dayContent.split('==== process started pid=').length - 1).toBe(1);

    const errorsContent = fs.readFileSync(path.join(dir, 'errors.log'), 'utf8');
    expect(errorsContent).toContain('[probe-append] ERROR: kaboom');
    expect(errorsContent).not.toContain('just fyi');
  });

  it('combines every producer into one errors.log', () => {
    writeOpsLog('probe-a', 'error', 'route blew up');
    writeOpsLog('probe-b', 'error', 'scrape blew up');

    const errorsContent = fs.readFileSync(path.join(dir, 'errors.log'), 'utf8');
    expect(errorsContent).toContain('[probe-a] ERROR: route blew up');
    expect(errorsContent).toContain('[probe-b] ERROR: scrape blew up');
  });

  it('keeps errors.log bounded: append-only until the byte trigger, then a tail trim', () => {
    // Stack-carrying lines (~2KB each): ~130 of them cross the 256KB
    // trigger — a line-count target would never bind here (the P1-2 bug:
    // every write would rewrite the same oversized file, growing forever).
    const bigMessage = `failure ${'d'.repeat(2000)}`;
    for (let i = 0; i < 130; i += 1) {
      writeOpsLog('probe-storm', 'error', `${bigMessage} #${i}`);
    }
    const errorsPath = path.join(dir, 'errors.log');
    const size = fs.statSync(errorsPath).size;
    // One post-trigger trim lands near the 128KB target; later writes
    // re-append below the trigger (bounded, hysteresis working).
    expect(size).toBeLessThan(ERRORS_TRIM_TRIGGER_BYTES + 9000);
    const content = fs.readFileSync(errorsPath, 'utf8');
    // Tail preserved (newest), onset washed out (documented trade-off).
    expect(content).toContain('#129');
    expect(content).not.toContain('#0\n');
  });

  // POSIX-only: Windows stat() always reports 0666 regardless of the mode
  // option, so there is nothing to assert there (the implementation still
  // passes mode: 0o600/0o700, which binds on the Linux bot host).
  (process.platform === 'win32' ? it.skip : it)(
    'creates log files readable only by the owner (0600)',
    () => {
      writeOpsLog('probe-perms', 'error', 'secret-adjacent');
      const dayName = dayFileName('probe-perms', Date.now());
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(path.join(dir, dayName)).mode & 0o777).toBe(0o600);
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(path.join(dir, 'errors.log')).mode & 0o777).toBe(
        0o600,
      );
    },
  );

  it('resetOpsLogRuntimeState re-arms init and sweep for the same service', () => {
    writeOpsLog('probe-reset', 'error', 'one');
    resetOpsLogRuntimeState();
    writeOpsLog('probe-reset', 'error', 'two');

    const dayName = dayFileName('probe-reset', Date.now());
    const content = fs.readFileSync(path.join(dir, dayName), 'utf8');
    expect(content.split('==== process started pid=').length - 1).toBe(2);
    expect(content).toContain('two');
  });

  it('never throws when the disk fails (console already happened upstream)', () => {
    jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => writeOpsLog('probe-disk', 'error', 'lost')).not.toThrow();
  });

  it('latches writes off after a read-only failure, but retries ordinary ones', () => {
    // Vercel hot path: the first EROFS arms the latch; later writes make
    // zero fs attempts instead of repaying doomed syscalls per error.
    const roError = Object.assign(new Error('read-only filesystem'), {
      code: 'EROFS',
    });
    const appendSpy = jest
      .spyOn(fs, 'appendFileSync')
      .mockImplementation(() => {
        throw roError;
      });
    const statSpy = jest.spyOn(fs, 'statSync');
    try {
      expect(() => writeOpsLog('probe-ro', 'error', 'one')).not.toThrow();
      const callsAfterFirst = appendSpy.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      writeOpsLog('probe-ro', 'error', 'two');
      expect(appendSpy.mock.calls.length).toBe(callsAfterFirst);
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      clearOpsLogFsDisabled();
    }
    // An ordinary failure (full disk, not read-only) never latches: the
    // next write still attempts — and succeeds once the disk recovers.
    appendSpy.mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => writeOpsLog('probe-ro2', 'error', 'one')).not.toThrow();
    } finally {
      appendSpy.mockRestore();
      clearOpsLogFsDisabled();
    }
    writeOpsLog('probe-ro2', 'error', 'two');
    const dayName = dayFileName('probe-ro2', Date.now());
    expect(fs.readFileSync(path.join(dir, dayName), 'utf8')).toContain('two');
  });

  it('recovers when the log dir is removed mid-run (operator cleanup)', () => {
    writeOpsLog('probe-rm', 'error', 'before');
    const dayName = dayFileName('probe-rm', Date.now());
    expect(fs.existsSync(path.join(dir, dayName))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => writeOpsLog('probe-rm', 'error', 'after')).not.toThrow();
    const content = fs.readFileSync(path.join(dir, dayName), 'utf8');
    expect(content).toContain('after');
  });

  it('deletes expired day files on init and keeps fresh ones', () => {
    const dayMs = 86_400_000;
    const nowMs = Date.now();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const old = new Date(nowMs - 30 * dayMs).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `probe-ret-${old}.log`), 'old\n');
    fs.writeFileSync(path.join(dir, `probe-ret-${today}.log`), 'fresh\n');
    writeOpsLog('probe-ret', 'info', 'trigger');
    expect(fs.existsSync(path.join(dir, `probe-ret-${old}.log`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `probe-ret-${today}.log`))).toBe(true);
  });

  it('re-sweeps retention when the UTC day rolls over mid-process', () => {
    const dayMs = 86_400_000;
    const t0 = Date.parse('2026-09-19T10:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const boundaries = () =>
      fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('probe-rollover-day-'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('')
        .split('==== process started pid=').length - 1;
    writeOpsLog('probe-rollover-day', 'info', 'day one');
    const oldName = 'probe-rollover-day-2026-09-19.log';
    expect(fs.existsSync(path.join(dir, oldName))).toBe(true);
    // Next day, same process: sweep re-runs silently — but NO second boot
    // boundary (operators tail that marker for real restarts; a daily
    // false positive would train them to ignore it).
    nowSpy.mockReturnValue(t0 + dayMs);
    writeOpsLog('probe-rollover-day', 'info', 'day two');
    expect(
      fs.existsSync(path.join(dir, 'probe-rollover-day-2026-09-20.log')),
    ).toBe(true);
    expect(boundaries()).toBe(1);
    // Thirty days later in the same process: the first days' files are
    // past the 14-day window and must be swept on this write, not "on
    // start".
    nowSpy.mockReturnValue(t0 + 30 * dayMs);
    writeOpsLog('probe-rollover-day', 'info', 'day thirty');
    expect(fs.existsSync(path.join(dir, oldName))).toBe(false);
    expect(
      fs.existsSync(
        path.join(dir, 'probe-rollover-day-2026-10-19.log'),
      ),
    ).toBe(true);
  });

  it('rolls over to incrementing sidecars, preserving the storm onset', () => {
    const big = `x${'y'.repeat(10 * 1024 * 1024)}`;
    const dayName = dayFileName('probe-roll', Date.now());
    const sidecar = (n: number) => dayName.replace(/\.log$/, `.${n}.log`);
    // Pre-flooded day file rolls to .1 (the onset); the triggering line
    // lands in the fresh day file.
    fs.writeFileSync(path.join(dir, dayName), `${big}\n`);
    writeOpsLog('probe-roll', 'error', 'storm one');
    expect(fs.existsSync(path.join(dir, sidecar(1)))).toBe(true);
    expect(fs.readFileSync(path.join(dir, dayName), 'utf8')).toContain(
      'storm one',
    );
    // Flood again: the second storm (storm one + flood) lands in .2 — .1
    // (the original onset) survives instead of being overwritten.
    fs.appendFileSync(path.join(dir, dayName), big);
    writeOpsLog('probe-roll', 'error', 'storm two');
    expect(fs.existsSync(path.join(dir, sidecar(2)))).toBe(true);
    expect(fs.readFileSync(path.join(dir, sidecar(2)), 'utf8')).toContain(
      'storm one',
    );
    expect(fs.readFileSync(path.join(dir, dayName), 'utf8')).toContain(
      'storm two',
    );
  });

  it('caps rollovers at .9, overwriting the newest continuation (onset survives)', () => {
    const big = `x${'y'.repeat(10 * 1024 * 1024)}`;
    const dayName = dayFileName('probe-cap', Date.now());
    const sidecar = (n: number) => dayName.replace(/\.log$/, `.${n}.log`);
    // Pre-fill every slot: the next storm must land on .9, and must never
    // create a .10 (unbounded growth by another name).
    for (let n = 1; n <= 9; n += 1) {
      fs.writeFileSync(path.join(dir, sidecar(n)), `old-${n}\n`);
    }
    fs.writeFileSync(path.join(dir, dayName), `${big}\n`);
    writeOpsLog('probe-cap', 'error', 'storm capped');
    expect(fs.existsSync(path.join(dir, sidecar(9)))).toBe(true);
    expect(fs.existsSync(path.join(dir, dayName.replace(/\.log$/, '.10.log')))).toBe(
      false,
    );
    // The flooded day file (not the new line) rolled into .9, evicting the
    // previous newest continuation; the fresh day file carries the storm.
    expect(fs.readFileSync(path.join(dir, sidecar(9)), 'utf8')).not.toContain(
      'old-9',
    );
    expect(fs.readFileSync(path.join(dir, dayName), 'utf8')).toContain(
      'storm capped',
    );
    // .1 (the storm onset) is untouched by the cap overwrite.
    expect(fs.readFileSync(path.join(dir, sidecar(1)), 'utf8')).toBe('old-1\n');
  });
});

describe('installCrashHandlers', () => {
  let dir: string;
  let savedDir: string | undefined;
  const captured = new Map<string, (value: unknown) => void>();
  let onSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    savedDir = process.env.OPS_LOG_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opslog-crash-'));
    process.env.OPS_LOG_DIR = dir;
    captured.clear();
    onSpy = jest
      .spyOn(process, 'on')
      .mockImplementation(((event: string, listener: (value: unknown) => void) => {
        captured.set(event, listener);
        return process;
      }) as typeof process.on);
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.OPS_LOG_DIR;
    else process.env.OPS_LOG_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('routes crashes to stderr AND the file, then exits 1', () => {
    const exit = jest.fn();
    installCrashHandlers('probe-crash', exit);

    expect(captured.has('uncaughtException')).toBe(true);
    expect(captured.has('unhandledRejection')).toBe(true);
    captured.get('uncaughtException')?.(new Error('boom'));

    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalled();
    const dayFiles = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('probe-crash-'));
    expect(dayFiles).toHaveLength(1);
    const content = fs.readFileSync(path.join(dir, dayFiles[0]), 'utf8');
    expect(content).toContain('uncaughtException');
    expect(content).toContain('boom');
  });

  it('stringifies non-Error throws instead of logging undefined', () => {
    const exit = jest.fn();
    installCrashHandlers('probe-crash-plain', exit);

    captured.get('uncaughtException')?.('plain string throw');

    expect(exit).toHaveBeenCalledWith(1);
    const dayFiles = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('probe-crash-plain-'));
    const content = fs.readFileSync(path.join(dir, dayFiles[0]), 'utf8');
    expect(content).toContain('plain string throw');
    expect(content).not.toContain('undefined');
  });
});

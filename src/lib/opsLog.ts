/**
 * Persistent ops logging — the bug-capture net for unattended processes.
 *
 * Every failure path in the Watch surface already logs to the console
 * (logRouteError in routes, WatchBotLogger in the bot) — but console output
 * only exists while somebody is watching the terminal. This module adds the
 * durable side: the same messages, appended to human-readable day files
 * under `.data/logs/`, so a one-off 3am failure is still discoverable the
 * next morning. Strictly additive: callers keep their console behavior
 * byte-identical; the file write happens alongside and never throws (a
 * full disk or read-only filesystem degrades to console-only, same pattern
 * as the heartbeat writer in bot-steam/heartbeat.ts).
 *
 * Sanitization happens HERE, at the persistence boundary: a grep over the
 * route call sites showed ~30 of them pass RAW errors (getUserInfo,
 * getSteamId, getCloseFriends, ...), not sanitizeError() output — so the
 * "already sanitized upstream" assumption does not hold repo-wide.
 * Re-sanitizing is harmless (redaction markers converge — applying the
 * replacements twice reaches the same fixed point), and it protects all
 * three producers plus the crash handlers with one choke point. Never
 * write raw chat text, credentials, or .env values here; if a new field
 * ever risks carrying them, extend sanitizeError, not this file. Precise
 * guarantee: KNOWN secret shapes (tokens, keys, passwords, sessions,
 * cookies, clearance values, auth headers — in literal `=`/`:` and
 * JSON-quoted forms) never reach disk. Bare prose with no delimiter and
 * non-string JSON values are out of reach by construction (see
 * sanitizeError's docblock).
 *
 * Layout (all under OPS_LOG_DIR, default <cwd>/.data/logs — .data/ is
 * gitignored, so logs never enter the repo):
 *   <service>-<YYYY-MM-DD>.log   every line from that producer that day
 *   <service>-<date>.N.log        rolled-over continuations of a flooded day
 *                                 file (onset preserved in .1, see below)
 *   errors.log                    error lines from EVERY producer combined.
 *                                 Append-only across processes (appends are
 *                                 practically atomic for small lines, so
 *                                 concurrent writers never lose each other's
 *                                 lines); trimmed to a 128KB tail only once
 *                                 past 256KB, via tmp+rename (atomic for
 *                                 concurrent readers). Byte-based trigger AND
 *                                 target: a line-count target would never
 *                                 bind when lines carry 2KB stacks.
 * Files are created 0o600, dirs 0o700 (creation-time only — pre-existing
 * files keep their mode; umask still applies).
 * Concurrency note: only appends ever race between processes — day files
 * are per-service (one writer each) and the combined file is append-only,
 * so the old read-modify-write lost-update hole is gone. A trim racing an
 * append can theoretically drop the racing line; trims are rare
 * (size-gated) and bounded to that window — accepted.
 * Vercel note: serverless functions have a read-only filesystem (except
 * /tmp), so writes there fail and degrade to console-only — which is the
 * correct behavior there (Vercel keeps its own request logs). The first
 * such failure latches writes off for the process lifetime (no doomed
 * mkdir+append per error on warm lambdas); anything else keeps retrying.
 */
import fs from 'fs';
import path from 'path';

import { sanitizeError } from './sanitizeError';

export type OpsLogLevel = 'info' | 'error';

const ERRORS_FILE_NAME = 'errors.log';
const ERRORS_TRIM_TRIGGER_BYTES = 256 * 1024;
const ERRORS_TRIM_TARGET_BYTES = 128 * 1024;
const DAY_MS = 86_400_000;
const MAX_DAY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROLLOVERS = 9;
const MAX_LINE_CHARS = 8000;
// Sanitize runs ~9 regexes: cap the input first so one multi-MB event
// (e.g. an HTML error page) is never processed whole. Cutting mid-value
// is safe (the secret name precedes its value); the final line cap stays.
const PRE_SANITIZE_CHARS = 16 * 1024;
const DEFAULT_RETENTION_DAYS = 14;

// ---------------------------------------------------------------------------
// Pure, no-I/O pieces (unit-tested directly, same split as evaluateHeartbeat)
// ---------------------------------------------------------------------------

/**
 * Collapse line breaks AND strip control characters: one event is always
 * exactly one inert file line. Beyond \r\n\v\f\u2028\u2029 this covers the
 * C0/C1 controls — notably ESC (\x1b): log lines are tailed straight into
 * terminals (`pnpm run logs:errors`, `tail -f`), and an escape sequence
 * smuggled in via user-controlled input (e.g. a proxy steamId) would
 * otherwise execute there. Single spaces keep word separation.
 */
// The whole point here is matching controls.
const singleLine = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/\r\n|[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

/** Hard cap for any logged string (giant HTML bodies, huge stacks). */
export const truncateString = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...[truncated]`;

/** Flatten one context value without ever throwing. */
const flattenValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  // Errors stringify to {} — log the message instead (stacks travel via
  // the dedicated `stack` context key the callers set, not here).
  if (value instanceof Error) return `Error: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};

/** ` | key=value key2=value2` — flat and grep-friendly, '' when empty. */
export const flattenContext = (
  context?: Record<string, unknown>,
): string => {
  if (!context) return '';
  const pairs = Object.entries(context).map(
    ([key, value]) => `${key}=${flattenValue(value)}`,
  );
  return pairs.length === 0 ? '' : ` | ${pairs.join(' ')}`;
};

/**
 * One file line. The message AND the flattened context are sanitized here
 * (see the module docblock for why the boundary — not the call site — owns
 * this). The final line is hard-capped so one pathological event cannot
 * flood the file. `nowMs` is injectable for deterministic tests.
 */
export const formatOpsLine = (
  service: string,
  level: OpsLogLevel,
  message: string,
  context?: Record<string, unknown>,
  nowMs: number = Date.now(),
): string => {
  const timestamp = new Date(nowMs).toISOString();
  const cleanMessage = sanitizeError(
    singleLine(truncateString(message, PRE_SANITIZE_CHARS)),
  );
  const flatContext = sanitizeError(singleLine(flattenContext(context)));
  return truncateString(
    `[${timestamp}] [${service}] ${level.toUpperCase()}: ${cleanMessage}${flatContext}`,
    MAX_LINE_CHARS,
  );
};

/** Keep service names filesystem-safe (they are ours, this is belt-and-braces). */
const safeServiceName = (service: string): string =>
  service.replace(/[^a-z0-9-]+/gi, '-');

export const dayFileName = (service: string, nowMs: number): string =>
  `${safeServiceName(service)}-${new Date(nowMs).toISOString().slice(0, 10)}.log`;

/**
 * Retention filter over `<service>-<YYYY-MM-DD>(.N)?.log` names. Anything
 * that does not match (errors.log, foreign files) is NEVER expired by us.
 * A day file expires when its UTC midnight is older than `retentionDays`
 * days back from today (inclusive keep window).
 */
export const isLogFileExpired = (
  fileName: string,
  service: string,
  retentionDays: number,
  nowMs: number = Date.now(),
): boolean => {
  const escaped = safeServiceName(service).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const match = new RegExp(
    `^${escaped}-(\\d{4}-\\d{2}-\\d{2})(\\.\\d+)?\\.log$`,
  ).exec(fileName);
  if (!match) return false;
  const dayStart = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart)) return false;
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return dayStart < todayStart - (retentionDays - 1) * DAY_MS;
};

/**
 * Byte-based tail trim with a line-boundary cut: keep at most `maxBytes`
 * bytes of complete trailing lines (the file always ends with '\n' when
 * non-empty). Byte — not line — criterion: with ~2KB stacked lines, a
 * 500-line target would never bind past a 256KB trigger, rewriting the
 * same oversized content on EVERY error write (and growing forever).
 */
export const trimToTailBytes = (
  content: string,
  maxBytes: number,
): string => {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return content;
  const tail = buf.slice(-maxBytes).toString('utf8');
  const firstNewline = tail.indexOf('\n');
  if (firstNewline === -1) return '';
  return tail.slice(firstNewline + 1);
};

/** Rollover decision: a runaway error loop must not grow one file forever. */
export const shouldRolloverFile = (
  sizeBytes: number,
  maxBytes: number = MAX_DAY_FILE_BYTES,
): boolean => sizeBytes >= maxBytes;

// ---------------------------------------------------------------------------
// Environment resolution (also pure-ish, unit-tested)
// ---------------------------------------------------------------------------

export const resolveOpsLogDir = (): string =>
  process.env.OPS_LOG_DIR || path.join(process.cwd(), '.data', 'logs');

export const resolveRetentionDays = (): number => {
  const raw = process.env.OPS_LOG_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RETENTION_DAYS;
};

// ---------------------------------------------------------------------------
// File I/O — everything in here swallows its own failures (never throws)
// ---------------------------------------------------------------------------

/**
 * Per-service init state, keyed by service AND directory (OPS_LOG_DIR can
 * differ between test workers sharing one module registry shape) to last
 * sweep day. The sweep re-runs when the UTC day rolls over, so a process
 * that stays up for weeks still expires old files — "on start" alone
 * would mean "never" for long-lived bots.
 */
const serviceSweepDays = new Map<string, string>();
/** True boot markers (boundary lines): set once per service per process. */
const initializedServices = new Set<string>();
// Global-per-process by design, not per-service: bot, proxy and site run
// in separate processes, so one flag is unambiguous. If those ever share
// a process, scope this per service.
let fsWritesDisabled = false;

/**
 * Full runtime-state reset for tests: sweep days, boot markers, and the
 * fs-disabled latch. Production code never calls this (module state is
 * per-process by design); tests use it instead of relying on unique
 * service names alone when asserting init/sweep behavior across cases.
 */
export const resetOpsLogRuntimeState = (): void => {
  serviceSweepDays.clear();
  initializedServices.clear();
  fsWritesDisabled = false;
};

const isReadonlyFsError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { code?: unknown }).code === 'EROFS' ||
    (error as { code?: unknown }).code === 'EACCES');

const ensureServiceInitialized = (
  service: string,
  logDir: string,
  nowMs: number,
): void => {
  const key = `${service}::${logDir}`;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (serviceSweepDays.get(key) === today) return;
  // The boot boundary is a TRUE first-init marker (long-lived processes
  // must not print "process started" on every UTC midnight — operators
  // tail it to spot real restarts). The retention sweep re-runs silently
  // on day rollover; only the boundary is boot-gated.
  const isFirstInit = !initializedServices.has(key);
  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    // Retention sweep (best-effort per file — one unreadable entry must
    // not cancel the rest). Also collects THIS process's trim leftovers
    // (errors.log.tmp-<pid>) from a kill mid-trim — never another live
    // process's (its rename would then fail silently).
    const retentionDays = resolveRetentionDays();
    fs.readdirSync(logDir)
      .filter(
        (entry) =>
          entry === `${ERRORS_FILE_NAME}.tmp-${process.pid}` ||
          isLogFileExpired(entry, service, retentionDays, nowMs),
      )
      .forEach((entry) => {
        try {
          fs.unlinkSync(path.join(logDir, entry));
        } catch {
          // Best-effort per file — one unreadable entry skips itself.
        }
      });
    if (isFirstInit) {
      fs.appendFileSync(
        path.join(logDir, dayFileName(service, nowMs)),
        `==== process started pid=${process.pid} ====\n`,
        { mode: 0o600 },
      );
      initializedServices.add(key);
    }
    // Mark swept ONLY on success: a failed init retries on the next write
    // instead of deferring the sweep to the next UTC day.
    serviceSweepDays.set(key, today);
  } catch (error) {
    // Read-only failures propagate so writeOpsLog can latch writes off
    // (see above); anything else degrades to console-only (the caller's
    // console log already happened).
    if (isReadonlyFsError(error)) throw error;
  }
};

/** Structural ENOENT check (no NodeJS namespace — undefined in this lint env). */
const isEnoentError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ENOENT';

/**
 * Latched off after the first read-only failure: on Vercel (read-only
 * filesystem) every site error would otherwise repay a doomed mkdir +
 * append per write for the whole warm-lambda lifetime. EROFS/EACCES are
 * environmental, not transient — a process that cannot write its log dir
 * stays that way until restart, so latching is safe. Test seam below
 * resets it (module state, same as the sweep map). Declaration lives with
 * the other module state above; assignment-only use here.
 */

/** Test seam (mirrors clearBotLivenessMemo): re-arms file writes. */
export const clearOpsLogFsDisabled = (): void => {
  fsWritesDisabled = false;
};

/**
 * Append that survives a mid-run `rm -rf` of the log dir (an operator
 * "cleaning up" a long-lived bot): on ENOENT, recreate the directory and
 * retry once. Any other failure propagates to the caller's silent catch.
 */
const appendWithDirRetry = (filePath: string, data: string): void => {
  // mode applies at creation only (pre-existing files keep theirs; umask
  // still applies) — enough for the "no world-readable secrets" bar.
  try {
    fs.appendFileSync(filePath, data, { mode: 0o600 });
  } catch (error) {
    if (!isEnoentError(error)) throw error;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, data, { mode: 0o600 });
  }
};

/**
 * First free rollover slot (.1, .2, ...) so a second storm the same day
 * does not overwrite the first — .1 always holds the storm's onset. Past
 * the cap, the newest continuation is overwritten (onset preserved).
 */
const nextRolloverPath = (dayPath: string): string => {
  const base = dayPath.replace(/\.log$/, '');
  const free = Array.from(
    { length: MAX_ROLLOVERS },
    (_, index) => `${base}.${index + 1}.log`,
  ).find((candidate) => !fs.existsSync(candidate));
  return free ?? `${base}.${MAX_ROLLOVERS}.log`;
};

/** Size-triggered errors.log trim through tmp+rename (atomic for readers). */
const trimErrorsFileIfOversized = (errorsPath: string): void => {
  try {
    if (fs.statSync(errorsPath).size <= ERRORS_TRIM_TRIGGER_BYTES) return;
    const tmpPath = `${errorsPath}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmpPath,
      trimToTailBytes(
        fs.readFileSync(errorsPath, 'utf8'),
        ERRORS_TRIM_TARGET_BYTES,
      ),
      { mode: 0o600 },
    );
    fs.renameSync(tmpPath, errorsPath);
  } catch {
    // Best-effort: the untrimmed file is still complete and readable.
  }
};

/**
 * Append one line to the service day-file (+ errors.log for errors).
 * The line is formatted ONCE and reused for both files. Never throws —
 * any fs failure degrades silently to console-only.
 */
export const writeOpsLog = (
  service: string,
  level: OpsLogLevel,
  message: string,
  context?: Record<string, unknown>,
): void => {
  if (fsWritesDisabled) return;
  try {
    const logDir = resolveOpsLogDir();
    const nowMs = Date.now();
    ensureServiceInitialized(service, logDir, nowMs);
    const line = `${formatOpsLine(service, level, message, context, nowMs)}\n`;
    const dayPath = path.join(logDir, dayFileName(service, nowMs));
    // Size safety: roll a flooded day file aside instead of growing it
    // forever (an error loop is itself a plausible bug to survive).
    try {
      if (shouldRolloverFile(fs.statSync(dayPath).size)) {
        fs.renameSync(dayPath, nextRolloverPath(dayPath));
      }
    } catch {
      // Missing file (first write) or stat/rename failure — just append.
    }
    appendWithDirRetry(dayPath, line);
    if (level !== 'error') return;
    // Append-only across processes (see module docblock) — trim only when
    // oversized, never rewrite per write.
    const errorsPath = path.join(logDir, ERRORS_FILE_NAME);
    appendWithDirRetry(errorsPath, line);
    trimErrorsFileIfOversized(errorsPath);
  } catch (error) {
    if (isReadonlyFsError(error)) fsWritesDisabled = true;
    // Console-only degradation (see module docblock).
  }
};

/**
 * Shared last-resort crash handlers for the standalone processes
 * (bot, proxy-local) — one definition so the two entrypoints cannot drift.
 * The trace goes to BOTH stderr (registering the handler replaces Node's
 * default dump — re-emit it, or crashes vanish from the supervisor
 * journal and a disk failure leaves no trace anywhere) and the durable
 * file, then exits non-zero for supervisor restart. Deliberately NOT used
 * by the Next.js dev server (hot-reload semantics).
 */
export const installCrashHandlers = (
  service: string,
  exit: (code: number) => void = process.exit,
): void => {
  const die = (kind: string, value: unknown): void => {
    const detail =
      value instanceof Error ? (value.stack ?? value.message) : String(value);
    // eslint-disable-next-line no-console
    console.error(`[${service}] ${kind}:`, value);
    writeOpsLog(service, 'error', `${kind}: ${detail}`);
    exit(1);
  };
  process.on('uncaughtException', (error: Error) =>
    die('uncaughtException', error),
  );
  process.on('unhandledRejection', (reason: unknown) =>
    die('unhandledRejection', reason),
  );
};

export {
  ERRORS_TRIM_TRIGGER_BYTES,
  ERRORS_TRIM_TARGET_BYTES,
  MAX_DAY_FILE_BYTES,
  MAX_LINE_CHARS,
  MAX_ROLLOVERS,
  DEFAULT_RETENTION_DAYS,
};

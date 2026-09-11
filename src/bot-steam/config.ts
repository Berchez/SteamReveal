/**
 * Watch Bot configuration — pure env parsing, no I/O, no Steam calls.
 *
 * Every secret stays in process.env (local .env, never committed) and is
 * NEVER logged, not even partially: log lines in this service must not
 * interpolate any of these values. Tests assert that.
 */

import parsePositiveInt from './parsePositiveInt';

export interface BotConfig {
  accountName: string;
  /** Steam password (used on every logon together with a fresh TOTP code). */
  password: string;
  /** Shared secret for TOTP (Steam Guard mobile authenticator). */
  sharedSecret: string;
  /** steam-user dataDirectory: machine id / cellid / sentry persistence. */
  dataDirectory: string;
  heartbeatPath: string;
  heartbeatIntervalMs: number;
  /** Healthcheck: heartbeat older than this is stale. */
  heartbeatStaleMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  invitePollIntervalMs: number;
  inviteBatchLimit: number;
  /**
   * Global cap on REAL friend invites sent per UTC day (abuse bound).
   * Since Steam OpenID login, a request always targets the requester's OWN
   * profile (session id) — unsolicited invites to third parties are
   * impossible by construction, which retired the old P1-1 anonymous-abuse
   * model. The cap stays as the flood-control backstop at the sink (the
   * only place that actually touches Steam): with the defaults below, one
   * bot sends at most 5/min and 50/day no matter how many requests arrive.
   * Tune both numbers as one explicit product decision, not in isolation.
   */
  inviteDailyLimit: number;
  inviteMaxAttempts: number;
  /** Watchdog for a single addFriend call (a hang must fail visibly). */
  inviteSendTimeoutMs: number;
  notifyPollIntervalMs: number;
  notifyBatchLimit: number;
  notifyMaxAttempts: number;
  /** Watchdog for a single sendFriendMessage call (same rationale). */
  notifySendTimeoutMs: number;
  /** Notify events older than this (by persisted created_at) are dropped. */
  notifyTtlDays: number;
  staleSweepIntervalMs: number;
  staleClaimWindowMinutes: number;
}

const DEFAULT_DATA_DIRECTORY = '.data/steam-bot';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
const DEFAULT_HEARTBEAT_STALE_MS = 180000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 60000;
const DEFAULT_INVITE_POLL_INTERVAL_MS = 60000;
const DEFAULT_INVITE_BATCH_LIMIT = 5;
const DEFAULT_INVITE_DAILY_LIMIT = 50;
const DEFAULT_INVITE_MAX_ATTEMPTS = 3;
const DEFAULT_INVITE_SEND_TIMEOUT_MS = 30000;
const DEFAULT_NOTIFY_POLL_INTERVAL_MS = 60000;
const DEFAULT_NOTIFY_BATCH_LIMIT = 10;
const DEFAULT_NOTIFY_MAX_ATTEMPTS = 3;
const DEFAULT_NOTIFY_SEND_TIMEOUT_MS = 30000;
const DEFAULT_NOTIFY_TTL_DAYS = 7;
const DEFAULT_STALE_SWEEP_INTERVAL_MS = 600000;
const DEFAULT_STALE_CLAIM_WINDOW_MINUTES = 30;

const readPositiveInt = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => parsePositiveInt(raw, name) ?? fallback;

const requireSecret = (value: string | undefined, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${name} is missing — set it in .env (see .env.example). The bot cannot log on without it.`,
    );
  }
  return value;
};

/**
 * Reads and validates the bot config from the environment. Throws with an
 * actionable message on the first problem (fail fast: a half-configured bot
 * must never start and retry against Steam with bad credentials).
 */
export const loadBotConfig = (
  env: Record<string, string | undefined> = process.env,
): BotConfig => {
  const accountName = requireSecret(
    env.STEAM_BOT_USERNAME,
    'STEAM_BOT_USERNAME',
  );
  const password = requireSecret(env.STEAM_BOT_PASSWORD, 'STEAM_BOT_PASSWORD');
  const sharedSecret = requireSecret(
    env.STEAM_BOT_SHARED_SECRET,
    'STEAM_BOT_SHARED_SECRET',
  );

  const dataDirectory =
    typeof env.BOT_DATA_DIR === 'string' && env.BOT_DATA_DIR !== ''
      ? env.BOT_DATA_DIR
      : DEFAULT_DATA_DIRECTORY;

  return {
    accountName,
    password,
    sharedSecret,
    dataDirectory,
    heartbeatPath:
      typeof env.BOT_HEARTBEAT_PATH === 'string' &&
      env.BOT_HEARTBEAT_PATH !== ''
        ? env.BOT_HEARTBEAT_PATH
        : `${dataDirectory}/heartbeat.json`,
    heartbeatIntervalMs: readPositiveInt(
      env.BOT_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'BOT_HEARTBEAT_INTERVAL_MS',
    ),
    heartbeatStaleMs: readPositiveInt(
      env.BOT_HEARTBEAT_STALE_MS,
      DEFAULT_HEARTBEAT_STALE_MS,
      'BOT_HEARTBEAT_STALE_MS',
    ),
    reconnectBaseMs: readPositiveInt(
      env.BOT_RECONNECT_BASE_MS,
      DEFAULT_RECONNECT_BASE_MS,
      'BOT_RECONNECT_BASE_MS',
    ),
    reconnectMaxMs: readPositiveInt(
      env.BOT_RECONNECT_MAX_MS,
      DEFAULT_RECONNECT_MAX_MS,
      'BOT_RECONNECT_MAX_MS',
    ),
    invitePollIntervalMs: readPositiveInt(
      env.BOT_INVITE_POLL_INTERVAL_MS,
      DEFAULT_INVITE_POLL_INTERVAL_MS,
      'BOT_INVITE_POLL_INTERVAL_MS',
    ),
    inviteBatchLimit: readPositiveInt(
      env.BOT_INVITE_BATCH_LIMIT,
      DEFAULT_INVITE_BATCH_LIMIT,
      'BOT_INVITE_BATCH_LIMIT',
    ),
    inviteDailyLimit: readPositiveInt(
      env.BOT_INVITE_DAILY_LIMIT,
      DEFAULT_INVITE_DAILY_LIMIT,
      'BOT_INVITE_DAILY_LIMIT',
    ),
    inviteMaxAttempts: readPositiveInt(
      env.BOT_INVITE_MAX_ATTEMPTS,
      DEFAULT_INVITE_MAX_ATTEMPTS,
      'BOT_INVITE_MAX_ATTEMPTS',
    ),
    inviteSendTimeoutMs: readPositiveInt(
      env.BOT_INVITE_SEND_TIMEOUT_MS,
      DEFAULT_INVITE_SEND_TIMEOUT_MS,
      'BOT_INVITE_SEND_TIMEOUT_MS',
    ),
    notifyPollIntervalMs: readPositiveInt(
      env.BOT_NOTIFY_POLL_INTERVAL_MS,
      DEFAULT_NOTIFY_POLL_INTERVAL_MS,
      'BOT_NOTIFY_POLL_INTERVAL_MS',
    ),
    notifyBatchLimit: readPositiveInt(
      env.BOT_NOTIFY_BATCH_LIMIT,
      DEFAULT_NOTIFY_BATCH_LIMIT,
      'BOT_NOTIFY_BATCH_LIMIT',
    ),
    notifyMaxAttempts: readPositiveInt(
      env.BOT_NOTIFY_MAX_ATTEMPTS,
      DEFAULT_NOTIFY_MAX_ATTEMPTS,
      'BOT_NOTIFY_MAX_ATTEMPTS',
    ),
    notifySendTimeoutMs: readPositiveInt(
      env.BOT_NOTIFY_SEND_TIMEOUT_MS,
      DEFAULT_NOTIFY_SEND_TIMEOUT_MS,
      'BOT_NOTIFY_SEND_TIMEOUT_MS',
    ),
    notifyTtlDays: readPositiveInt(
      env.BOT_NOTIFY_TTL_DAYS,
      DEFAULT_NOTIFY_TTL_DAYS,
      'BOT_NOTIFY_TTL_DAYS',
    ),
    staleSweepIntervalMs: readPositiveInt(
      env.BOT_STALE_SWEEP_INTERVAL_MS,
      DEFAULT_STALE_SWEEP_INTERVAL_MS,
      'BOT_STALE_SWEEP_INTERVAL_MS',
    ),
    staleClaimWindowMinutes: readPositiveInt(
      env.BOT_STALE_CLAIM_WINDOW_MINUTES,
      DEFAULT_STALE_CLAIM_WINDOW_MINUTES,
      'BOT_STALE_CLAIM_WINDOW_MINUTES',
    ),
  };
};

export const BOT_CONFIG_DEFAULTS = {
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  DEFAULT_INVITE_POLL_INTERVAL_MS,
  DEFAULT_INVITE_BATCH_LIMIT,
  DEFAULT_INVITE_DAILY_LIMIT,
  DEFAULT_INVITE_MAX_ATTEMPTS,
  DEFAULT_INVITE_SEND_TIMEOUT_MS,
  DEFAULT_NOTIFY_POLL_INTERVAL_MS,
  DEFAULT_NOTIFY_BATCH_LIMIT,
  DEFAULT_NOTIFY_MAX_ATTEMPTS,
  DEFAULT_NOTIFY_SEND_TIMEOUT_MS,
  DEFAULT_NOTIFY_TTL_DAYS,
  DEFAULT_STALE_SWEEP_INTERVAL_MS,
  DEFAULT_STALE_CLAIM_WINDOW_MINUTES,
};

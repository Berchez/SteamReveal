import { loadBotConfig, BOT_CONFIG_DEFAULTS } from './config';

const FULL_ENV = {
  STEAM_BOT_USERNAME: 'botuser',
  STEAM_BOT_PASSWORD: 'botpass',
  STEAM_BOT_SHARED_SECRET: 'botsecret',
  WATCH_SITE_URL: 'https://steam-reveal.vercel.app',
};

describe('loadBotConfig', () => {
  it('reads secrets and applies defaults for everything optional', () => {
    const config = loadBotConfig({ ...FULL_ENV });

    expect(config).toEqual({
      accountName: 'botuser',
      password: 'botpass',
      sharedSecret: 'botsecret',
      siteUrl: 'https://steam-reveal.vercel.app',
      dataDirectory: BOT_CONFIG_DEFAULTS.DEFAULT_DATA_DIRECTORY,
      heartbeatPath: `${BOT_CONFIG_DEFAULTS.DEFAULT_DATA_DIRECTORY}/heartbeat.json`,
      heartbeatIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatStaleMs: BOT_CONFIG_DEFAULTS.DEFAULT_HEARTBEAT_STALE_MS,
      reconnectBaseMs: BOT_CONFIG_DEFAULTS.DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: BOT_CONFIG_DEFAULTS.DEFAULT_RECONNECT_MAX_MS,
      invitePollIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_INVITE_POLL_INTERVAL_MS,
      inviteBatchLimit: BOT_CONFIG_DEFAULTS.DEFAULT_INVITE_BATCH_LIMIT,
      inviteDailyLimit: BOT_CONFIG_DEFAULTS.DEFAULT_INVITE_DAILY_LIMIT,
      inviteMaxAttempts: BOT_CONFIG_DEFAULTS.DEFAULT_INVITE_MAX_ATTEMPTS,
      inviteSendTimeoutMs: BOT_CONFIG_DEFAULTS.DEFAULT_INVITE_SEND_TIMEOUT_MS,
      notifyPollIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_NOTIFY_POLL_INTERVAL_MS,
      notifyBatchLimit: BOT_CONFIG_DEFAULTS.DEFAULT_NOTIFY_BATCH_LIMIT,
      notifyMaxAttempts: BOT_CONFIG_DEFAULTS.DEFAULT_NOTIFY_MAX_ATTEMPTS,
      notifySendTimeoutMs: BOT_CONFIG_DEFAULTS.DEFAULT_NOTIFY_SEND_TIMEOUT_MS,
      notifyTtlDays: BOT_CONFIG_DEFAULTS.DEFAULT_NOTIFY_TTL_DAYS,
      welcomePollIntervalMs:
        BOT_CONFIG_DEFAULTS.DEFAULT_WELCOME_POLL_INTERVAL_MS,
      welcomeBatchLimit: BOT_CONFIG_DEFAULTS.DEFAULT_WELCOME_BATCH_LIMIT,
      welcomeMaxAttempts: BOT_CONFIG_DEFAULTS.DEFAULT_WELCOME_MAX_ATTEMPTS,
      welcomeSendTimeoutMs:
        BOT_CONFIG_DEFAULTS.DEFAULT_WELCOME_SEND_TIMEOUT_MS,
      resendPollIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_RESEND_POLL_INTERVAL_MS,
      resendBatchLimit: BOT_CONFIG_DEFAULTS.DEFAULT_RESEND_BATCH_LIMIT,
      resendMaxAttempts: BOT_CONFIG_DEFAULTS.DEFAULT_RESEND_MAX_ATTEMPTS,
      resendSendTimeoutMs: BOT_CONFIG_DEFAULTS.DEFAULT_RESEND_SEND_TIMEOUT_MS,
      resendMinIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_RESEND_MIN_INTERVAL_MS,
      expiryScanIntervalMs:
        BOT_CONFIG_DEFAULTS.DEFAULT_EXPIRY_SCAN_INTERVAL_MS,
      reconcileIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_RECONCILE_INTERVAL_MS,
      confirmTokenTtlMs: BOT_CONFIG_DEFAULTS.DEFAULT_CONFIRM_TOKEN_TTL_MS,
      staleSweepIntervalMs: BOT_CONFIG_DEFAULTS.DEFAULT_STALE_SWEEP_INTERVAL_MS,
      staleClaimWindowMinutes:
        BOT_CONFIG_DEFAULTS.DEFAULT_STALE_CLAIM_WINDOW_MINUTES,
    });
  });

  it('honors explicit overrides including a custom heartbeat path', () => {
    const config = loadBotConfig({
      ...FULL_ENV,
      BOT_DATA_DIR: 'custom-dir',
      BOT_HEARTBEAT_PATH: 'custom/beat.json',
      BOT_HEARTBEAT_INTERVAL_MS: '5000',
      BOT_HEARTBEAT_STALE_MS: '15000',
      BOT_RECONNECT_BASE_MS: '500',
      BOT_RECONNECT_MAX_MS: '10000',
    });

    expect(config.dataDirectory).toBe('custom-dir');
    expect(config.heartbeatPath).toBe('custom/beat.json');
    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.heartbeatStaleMs).toBe(15000);
    expect(config.reconnectBaseMs).toBe(500);
    expect(config.reconnectMaxMs).toBe(10000);
  });

  it.each([
    ['STEAM_BOT_USERNAME'],
    ['STEAM_BOT_PASSWORD'],
    ['STEAM_BOT_SHARED_SECRET'],
  ])('throws naming the missing secret (%s)', (name) => {
    const env = { ...FULL_ENV };
    delete env[name as keyof typeof FULL_ENV];

    expect(() => loadBotConfig(env)).toThrow(name);
  });

  it('requires WATCH_SITE_URL and strips trailing slashes', () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).WATCH_SITE_URL;
    expect(() => loadBotConfig(env)).toThrow('WATCH_SITE_URL');

    expect(
      loadBotConfig({ ...FULL_ENV, WATCH_SITE_URL: 'https://x.example///' })
        .siteUrl,
    ).toBe('https://x.example');
  });

  it.each([
    ['steam-reveal.vercel.app'],
    ['not a url'],
    ['ftp://files.example/x'],
    ['https://'],
  ])(
    'rejects a malformed WATCH_SITE_URL (%s) at boot, not in sent links',
    (value) => {
      expect(() =>
        loadBotConfig({ ...FULL_ENV, WATCH_SITE_URL: value }),
      ).toThrow('WATCH_SITE_URL');
    },
  );

  it.each([
    ['BOT_HEARTBEAT_INTERVAL_MS', '0'],
    ['BOT_HEARTBEAT_STALE_MS', '-5'],
    ['BOT_RECONNECT_BASE_MS', 'not-a-number'],
    ['BOT_RECONNECT_MAX_MS', 'Infinity'],
    ['BOT_INVITE_POLL_INTERVAL_MS', '0'],
    ['BOT_INVITE_BATCH_LIMIT', '-1'],
    ['BOT_INVITE_DAILY_LIMIT', '0'],
    ['BOT_INVITE_MAX_ATTEMPTS', 'NaN'],
    ['BOT_INVITE_SEND_TIMEOUT_MS', '0'],
    ['BOT_NOTIFY_POLL_INTERVAL_MS', '0'],
    ['BOT_NOTIFY_BATCH_LIMIT', '-1'],
    ['BOT_NOTIFY_MAX_ATTEMPTS', 'NaN'],
    ['BOT_NOTIFY_SEND_TIMEOUT_MS', '0'],
    ['BOT_NOTIFY_TTL_DAYS', '0'],
    ['BOT_WELCOME_POLL_INTERVAL_MS', '0'],
    ['BOT_WELCOME_BATCH_LIMIT', '-1'],
    ['BOT_WELCOME_MAX_ATTEMPTS', 'NaN'],
    ['BOT_WELCOME_SEND_TIMEOUT_MS', '0'],
    ['BOT_RESEND_POLL_INTERVAL_MS', '0'],
    ['BOT_RESEND_BATCH_LIMIT', '-1'],
    ['BOT_RESEND_MAX_ATTEMPTS', 'NaN'],
    ['BOT_RESEND_SEND_TIMEOUT_MS', '0'],
    ['BOT_RESEND_MIN_INTERVAL_MS', '0'],
    ['BOT_EXPIRY_SCAN_INTERVAL_MS', '0'],
    ['BOT_RECONCILE_INTERVAL_MS', '0'],
    ['BOT_CONFIRM_TOKEN_TTL_MS', '0'],
    ['BOT_STALE_SWEEP_INTERVAL_MS', '0'],
    ['BOT_STALE_CLAIM_WINDOW_MINUTES', '-2'],
    // Fractional values would floor to 0 downstream ("always expired") —
    // rejected loudly instead.
    ['BOT_HEARTBEAT_INTERVAL_MS', '0.5'],
    ['BOT_STALE_CLAIM_WINDOW_MINUTES', '1.5'],
  ])('throws on invalid %s (%s)', (name, value) => {
    expect(() => loadBotConfig({ ...FULL_ENV, [name]: value })).toThrow(name);
  });
});

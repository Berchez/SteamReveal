import { loadBotConfig, BOT_CONFIG_DEFAULTS } from './config';

const FULL_ENV = {
  STEAM_BOT_USERNAME: 'botuser',
  STEAM_BOT_PASSWORD: 'botpass',
  STEAM_BOT_SHARED_SECRET: 'botsecret',
};

describe('loadBotConfig', () => {
  it('reads secrets and applies defaults for everything optional', () => {
    const config = loadBotConfig({ ...FULL_ENV });

    expect(config).toEqual({
      accountName: 'botuser',
      password: 'botpass',
      sharedSecret: 'botsecret',
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

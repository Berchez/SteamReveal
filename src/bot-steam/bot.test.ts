/**
 * WatchBot unit tests — steam-user is COMPLETELY mocked below (a fake
 * EventEmitter class). Nothing here may touch the real Steam network;
 * the TOTP generator is injected as a plain function for the same reason.
 */
import { EventEmitter } from 'events';

interface FakeClient extends EventEmitter {
  logOn: jest.Mock;
  logOff: jest.Mock;
  setPersona: jest.Mock;
  myFriends: Record<string, number>;
  steamID: { getSteamID64: () => string } | null;
}

jest.mock('steam-user', () => {
  const { EventEmitter: EE } = require('events');

  class FakeSteamUser extends EE {
    static EPersonaState = { Online: 1 };
    static EFriendRelationship = { None: 0, Blocked: 1, Friend: 3 };
    static EResult = { OK: 1, Fail: 2 };

    static created: FakeSteamUser[] = [];

    logOn = jest.fn();
    logOff = jest.fn();
    setPersona = jest.fn();
    myFriends: Record<string, number> = {};
    steamID: { getSteamID64: () => string } | null = null;

    constructor() {
      super();
      FakeSteamUser.created.push(this);
    }
  }

  return { __esModule: true, default: FakeSteamUser };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockedSteamUser = require('steam-user').default as unknown as {
  created: FakeClient[];
  EPersonaState: { Online: number };
} & (new () => FakeClient);

const { WatchBot } = require('./bot') as typeof import('./bot');

const ACCOUNT = 'botuser-SECRET-1';
const PASSWORD = 'pw-SECRET-2';
const SECRET = 'sh-SECRET-3';
const OTP = 'otp-SECRET-4';

const makeBot = (overrides: Record<string, unknown> = {}) => {
  const client = new MockedSteamUser();
  const logger = { info: jest.fn(), error: jest.fn() };
  const bot = new WatchBot({
    client: client as never,
    accountName: ACCOUNT,
    password: PASSWORD,
    sharedSecret: SECRET,
    reconnectBaseMs: 100,
    reconnectMaxMs: 300,
    generateTwoFactorCode: jest.fn(() => OTP),
    logger,
    ...overrides,
  });
  return { bot, client, logger };
};

const loggedLines = (logger: { info: jest.Mock; error: jest.Mock }) => [
  ...logger.info.mock.calls.map((call) => String(call[0])),
  ...logger.error.mock.calls.map((call) => String(call[0])),
];

describe('WatchBot', () => {
  beforeEach(() => {
    MockedSteamUser.created.length = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('start() logs on with account credentials and a fresh TOTP code', () => {
    const totp = jest.fn(() => OTP);
    const { bot, client } = makeBot({ generateTwoFactorCode: totp });

    bot.start();

    expect(totp).toHaveBeenCalledWith(SECRET);
    expect(client.logOn).toHaveBeenCalledTimes(1);
    expect(client.logOn).toHaveBeenCalledWith({
      accountName: ACCOUNT,
      password: PASSWORD,
      twoFactorCode: OTP,
    });
  });

  it('loggedOn marks connected, sets persona online, resets backoff', () => {
    const { bot, client } = makeBot();
    bot.start();

    client.emit('disconnected', 2, 'bye');
    jest.advanceTimersByTime(100);
    expect(client.logOn).toHaveBeenCalledTimes(2);

    client.emit('loggedOn', {}, {});
    expect(bot.isConnected()).toBe(true);
    expect(client.setPersona).toHaveBeenCalledWith(1);

    // Backoff counter reset: next disconnect waits base again, not doubled.
    client.emit('disconnected', 2, 'bye');
    jest.advanceTimersByTime(99);
    expect(client.logOn).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(client.logOn).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially and caps at max (100, 200, 300, 300...)', () => {
    const { bot, client } = makeBot();
    bot.start();
    expect(client.logOn).toHaveBeenCalledTimes(1);

    client.emit('disconnected', 2, 'x');
    jest.advanceTimersByTime(100);
    expect(client.logOn).toHaveBeenCalledTimes(2);

    client.emit('disconnected', 2, 'x');
    jest.advanceTimersByTime(199);
    expect(client.logOn).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(client.logOn).toHaveBeenCalledTimes(3);

    client.emit('disconnected', 2, 'x');
    jest.advanceTimersByTime(299);
    expect(client.logOn).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    expect(client.logOn).toHaveBeenCalledTimes(4);

    // Still capped on the 4th retry.
    client.emit('disconnected', 2, 'x');
    jest.advanceTimersByTime(300);
    expect(client.logOn).toHaveBeenCalledTimes(5);
  });

  it('coalesces repeated disconnects into a single pending timer', () => {
    const { bot, client } = makeBot();
    bot.start();

    client.emit('disconnected', 2, 'x');
    client.emit('disconnected', 2, 'x');
    client.emit('error', Object.assign(new Error('boom'), { eresult: 2 }));
    jest.advanceTimersByTime(1000);

    // start(1) + exactly one reconnect, not three.
    expect(client.logOn).toHaveBeenCalledTimes(2);
  });

  it('stop() clears timers, logs off, and start() becomes a no-op', () => {
    const { bot, client } = makeBot();
    bot.start();

    client.emit('disconnected', 2, 'x');
    bot.stop();

    expect(bot.isConnected()).toBe(false);
    expect(client.logOff).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60000);
    expect(client.logOn).toHaveBeenCalledTimes(1);

    bot.start();
    expect(client.logOn).toHaveBeenCalledTimes(1);
  });

  it('stop() survives a throwing logOff', () => {
    const { bot, client } = makeBot();
    client.logOff.mockImplementation(() => {
      throw new Error('already gone');
    });

    expect(() => bot.stop()).not.toThrow();
    expect(bot.isConnected()).toBe(false);
  });

  it('friendsList delivers a snapshot copy to the listener', () => {
    const onFriendsSnapshot = jest.fn();
    const { bot, client } = makeBot({ onFriendsSnapshot });
    bot.start();

    client.myFriends = { '76561198000000001': 3, '76561198000000002': 0 };
    client.emit('friendsList');
    bot.stop();

    expect(onFriendsSnapshot).toHaveBeenCalledTimes(1);
    expect(onFriendsSnapshot).toHaveBeenCalledWith({
      '76561198000000001': 3,
      '76561198000000002': 0,
    });
  });

  it('a throwing snapshot listener is contained and logged', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const onFriendsSnapshot = jest.fn(() => {
      throw new Error('reconcile blew up');
    });
    const { bot, client } = makeBot({ onFriendsSnapshot, logger });
    bot.start();

    expect(() => client.emit('friendsList')).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it('routes unfriend events to onFriendRemoved with the steamID64', () => {
    const onFriendRemoved = jest.fn();
    const { bot, client } = makeBot({ onFriendRemoved });
    bot.start();

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000001' },
      0,
    );
    expect(onFriendRemoved).toHaveBeenCalledTimes(1);
    expect(onFriendRemoved).toHaveBeenCalledWith('76561198000000001');
    bot.stop();
  });

  it('routes block events to onFriendRemoved too', () => {
    const onFriendRemoved = jest.fn();
    const { bot, client } = makeBot({ onFriendRemoved });
    bot.start();

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000002' },
      1,
    );
    expect(onFriendRemoved).toHaveBeenCalledTimes(1);
    expect(onFriendRemoved).toHaveBeenCalledWith('76561198000000002');
    bot.stop();
  });

  it('ignores non-removal relationship changes (friend, pending invite)', () => {
    const onFriendRemoved = jest.fn();
    const { bot, client } = makeBot({ onFriendRemoved });
    bot.start();

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000001' },
      3,
    );
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000002' },
      4,
    );
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000003' },
      2,
    );
    expect(onFriendRemoved).not.toHaveBeenCalled();
    bot.stop();
  });

  it('forwards live accept events as a snapshot including the new friend', () => {
    const onFriendRemoved = jest.fn();
    const onFriendsSnapshot = jest.fn();
    const { bot, client } = makeBot({ onFriendRemoved, onFriendsSnapshot });
    bot.start();

    // myFriends does NOT contain the accepted id yet (the library emits
    // before updating its own map) — the forwarded snapshot must merge it.
    client.myFriends = { '76561198000000001': 3 };
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000002' },
      3,
    );

    expect(onFriendRemoved).not.toHaveBeenCalled();
    expect(onFriendsSnapshot).toHaveBeenCalledTimes(1);
    expect(onFriendsSnapshot).toHaveBeenCalledWith({
      '76561198000000001': 3,
      '76561198000000002': 3,
    });
    bot.stop();
  });

  it('contains an unreadable steamId and subscribes only once across reconnects', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const onFriendRemoved = jest.fn();
    const { bot, client } = makeBot({ onFriendRemoved, logger });
    bot.start();

    expect(() =>
      client.emit(
        'friendRelationship',
        {
          getSteamID64: () => {
            throw new Error('malformed');
          },
        },
        0,
      ),
    ).not.toThrow();
    expect(onFriendRemoved).not.toHaveBeenCalled();

    // Reconnect re-runs attachListeners, but the once-guard must prevent a
    // second subscription: one event still fires exactly one callback.
    client.emit('loggedOn', {}, {});
    client.emit('disconnected', 2, 'x');
    client.emit('loggedOn', {}, {});
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000009' },
      0,
    );
    expect(onFriendRemoved).toHaveBeenCalledTimes(1);
    expect(onFriendRemoved).toHaveBeenCalledWith('76561198000000009');
    bot.stop();
  });

  it('removal logs carry the steamId and no secrets', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const seen: string[] = [];
    const onFriendRemoved = jest.fn((steamId: string) => {
      seen.push(steamId);
    });
    const { bot, client } = makeBot({ onFriendRemoved, logger });
    bot.start();

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000007' },
      0,
    );
    bot.stop();

    expect(seen).toEqual(['76561198000000007']);
    const lines = [
      ...logger.info.mock.calls.map((call) => String(call[0])),
      ...logger.error.mock.calls.map((call) => String(call[0])),
    ].join('\n');
    for (const secret of [ACCOUNT, PASSWORD, SECRET, OTP]) {
      expect(lines).not.toContain(secret);
    }
  });

  it('TOTP failure schedules a reconnect without calling logOn', () => {
    const generateTwoFactorCode = jest.fn(() => {
      throw new Error('bad secret');
    });
    const { bot, client } = makeBot({ generateTwoFactorCode });
    bot.start();

    expect(client.logOn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    // Still failing (same bad secret) — retried, never logged on.
    expect(client.logOn).not.toHaveBeenCalled();
    bot.stop();
  });

  it('synchronous logOn throw schedules a reconnect', () => {
    const { bot, client } = makeBot();
    client.logOn.mockImplementation(() => {
      throw new Error('misconfigured');
    });
    bot.start();

    expect(client.logOn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(100);
    expect(client.logOn).toHaveBeenCalledTimes(2);
    bot.stop();
  });

  it('getSteamId reflects the client session (null-safe)', () => {
    const { bot, client } = makeBot();

    expect(bot.getSteamId()).toBeNull();

    client.steamID = { getSteamID64: () => '76561198000000099' };
    expect(bot.getSteamId()).toBe('76561198000000099');

    client.steamID = {
      getSteamID64: () => {
        throw new Error('gone');
      },
    };
    expect(bot.getSteamId()).toBeNull();
    bot.stop();
  });

  it('fires onConnected on every logon and contains its failures', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const onConnected = jest.fn();
    const { bot, client } = makeBot({ onConnected, logger });
    bot.start();

    client.emit('loggedOn', {}, {});
    expect(onConnected).toHaveBeenCalledTimes(1);

    client.emit('disconnected', 2, 'x');
    client.emit('loggedOn', {}, {});
    expect(onConnected).toHaveBeenCalledTimes(2);

    onConnected.mockImplementation(() => {
      throw new Error('host blew up');
    });
    client.emit('loggedOn', {}, {});
    expect(onConnected).toHaveBeenCalledTimes(3);
    expect(bot.isConnected()).toBe(true);
    // One error from the disconnect above, one from the throwing callback.
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(
      logger.error.mock.calls.some((call) =>
        String(call[0]).includes('onConnected handler failed'),
      ),
    ).toBe(true);
    bot.stop();
  });

  it('never logs secrets across a full login/disconnect/snapshot cycle', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const onFriendsSnapshot = jest.fn();
    const { bot, client } = makeBot({ logger, onFriendsSnapshot });
    bot.start();

    client.emit('loggedOn', {}, {});
    client.myFriends = { '76561198000000001': 3 };
    client.emit('friendsList');
    client.emit('disconnected', 2, 'session replaced');
    client.emit('error', Object.assign(new Error('nope'), { eresult: 2 }));
    bot.stop();
    const lines = loggedLines(logger);

    expect(lines.length).toBeGreaterThan(0);
    const allLogs = lines.join('\n');
    for (const secret of [ACCOUNT, PASSWORD, SECRET, OTP]) {
      expect(allLogs).not.toContain(secret);
    }
  });
});

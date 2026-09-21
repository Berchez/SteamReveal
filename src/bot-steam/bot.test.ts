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
  addFriend: jest.Mock;
  myFriends: Record<string, number>;
  steamID: { getSteamID64: () => string } | null;
}

jest.mock('steam-user', () => {
  const { EventEmitter: EE } = require('events');

  class FakeSteamUser extends EE {
    static EPersonaState = { Online: 1 };
    static EFriendRelationship = {
      None: 0,
      Blocked: 1,
      RequestRecipient: 2,
      Friend: 3,
      RequestInitiator: 4,
    };
    static EResult = { OK: 1, Fail: 2 };

    static created: FakeSteamUser[] = [];

    logOn = jest.fn();
    logOff = jest.fn();
    setPersona = jest.fn();
    addFriend = jest.fn(async () => ({ personaName: 'x' }));
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

  it('accepts inbound friend requests (RequestRecipient) via addFriend', async () => {
    const onFriendRemoved = jest.fn();
    const onFriendsSnapshot = jest.fn();
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      onFriendRemoved,
      onFriendsSnapshot,
      logger,
    });
    bot.start();

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000001' },
      2,
    );
    // acceptFriendRequest is fire-and-forget: flush microtasks so the
    // bounded addFriend + log land before asserting.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(client.addFriend).toHaveBeenCalledTimes(1);
    expect(client.addFriend).toHaveBeenCalledWith('76561198000000001');
    expect(onFriendRemoved).not.toHaveBeenCalled();
    expect(onFriendsSnapshot).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0][0])).toContain(
      'accepted inbound friend request',
    );
    expect(logger.error).not.toHaveBeenCalled();
    bot.stop();
  });

  it('logs accept failures loudly without crashing (request stays pending)', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({ logger });
    bot.start();

    client.addFriend.mockRejectedValueOnce(new Error('limited account?'));
    expect(() =>
      client.emit(
        'friendRelationship',
        { getSteamID64: () => '76561198000000002' },
        2,
      ),
    ).not.toThrow();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(client.addFriend).toHaveBeenCalledWith('76561198000000002');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain(
      'friend-accept failed',
    );
    // Bot keeps working: a later inbound request is still accepted.
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000003' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(client.addFriend).toHaveBeenCalledWith('76561198000000003');
    bot.stop();
  });

  it('sweeps snapshot inbound requests (offline arrivals) sequentially, ignoring the rest', async () => {
    const onFriendsSnapshot = jest.fn();
    const { bot, client } = makeBot({ onFriendsSnapshot });
    bot.start();

    client.myFriends = {
      '76561198000000001': 3,
      '76561198000000002': 2,
      '76561198000000003': 2,
      '76561198000000004': 1,
      '76561198000000005': 4,
    };
    client.emit('friendsList');
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    // Existing forward behavior preserved untouched.
    expect(onFriendsSnapshot).toHaveBeenCalledTimes(1);
    // Only the two inbound-pending ids accepted, in map order.
    expect(client.addFriend).toHaveBeenCalledTimes(2);
    expect(client.addFriend).toHaveBeenNthCalledWith(
      1,
      '76561198000000002',
    );
    expect(client.addFriend).toHaveBeenNthCalledWith(
      2,
      '76561198000000003',
    );
    bot.stop();
  });

  it('refuses auto-accept at the friend cap (Sybil bound) without touching Steam', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      logger,
      autoAcceptFriendCap: 2,
      autoAcceptDailyLimit: 50,
    });
    bot.start();

    // 2 FRIEND entries already (pending inbound does NOT count toward it).
    client.myFriends = {
      '76561198000000010': 3,
      '76561198000000011': 3,
      '76561198000000012': 2,
    };
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000012' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(client.addFriend).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('REFUSED');
    expect(String(logger.error.mock.calls[0][0])).toContain('friend cap');
    bot.stop();
  });

  it('enforces the daily accept budget and rolls it over on UTC-day change', async () => {
    let now = Date.parse('2026-09-01T10:00:00.000Z');
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      logger,
      autoAcceptFriendCap: 240,
      autoAcceptDailyLimit: 2,
      nowMs: () => now,
    });
    bot.start();

    const emitRequest = (id: string) => {
      client.emit('friendRelationship', { getSteamID64: () => id }, 2);
    };
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    };

    emitRequest('76561198000000021');
    emitRequest('76561198000000022');
    await flush();
    expect(client.addFriend).toHaveBeenCalledTimes(2);

    // Third request same UTC day: refused, budget untouched by the refusal.
    emitRequest('76561198000000023');
    await flush();
    expect(client.addFriend).toHaveBeenCalledTimes(2);
    expect(
      logger.error.mock.calls.map((call) => String(call[0])),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('daily accept budget exhausted'),
      ]),
    );

    // Next UTC day: budget resets, the deferred request converges.
    now = Date.parse('2026-09-02T00:00:01.000Z');
    emitRequest('76561198000000023');
    await flush();
    expect(client.addFriend).toHaveBeenCalledTimes(3);
    expect(client.addFriend).toHaveBeenNthCalledWith(
      3,
      '76561198000000023',
    );
    bot.stop();
  });

  it('failed accepts never burn the daily budget', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      logger,
      autoAcceptDailyLimit: 1,
    });
    bot.start();

    client.addFriend.mockRejectedValueOnce(new Error('Steam throttled'));
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000031' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(client.addFriend).toHaveBeenCalledTimes(1);

    // The failure above burned nothing: a retry still goes through.
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000032' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(client.addFriend).toHaveBeenCalledTimes(2);
    bot.stop();
  });

  it('snapshot sweep pauses at the daily budget with one log line (rest deferred)', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const onFriendsSnapshot = jest.fn();
    const { bot, client } = makeBot({
      logger,
      onFriendsSnapshot,
      autoAcceptDailyLimit: 1,
    });
    bot.start();

    client.myFriends = {
      '76561198000000041': 2,
      '76561198000000042': 2,
      '76561198000000043': 2,
    };
    client.emit('friendsList');
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(onFriendsSnapshot).toHaveBeenCalledTimes(1);
    expect(client.addFriend).toHaveBeenCalledTimes(1);
    expect(client.addFriend).toHaveBeenCalledWith('76561198000000041');
    const errors = logger.error.mock.calls.map((call) => String(call[0]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sweep paused');
    expect(errors[0]).toContain('2 request(s) deferred');
    bot.stop();
  });

  it('sweepPendingRequests() retries deferred inbound requests on demand (timer path)', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({ logger });
    bot.start();

    // Live map holds a still-pending inbound request (e.g. deferred by an
    // earlier exhausted budget): the public sweep converges it without any
    // reconnect — this is what the 10-minute reconcile timer calls.
    client.myFriends = { '76561198000000051': 2 };
    bot.sweepPendingRequests();
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(client.addFriend).toHaveBeenCalledTimes(1);
    expect(client.addFriend).toHaveBeenCalledWith('76561198000000051');
    expect(logger.error).not.toHaveBeenCalled();
    bot.stop();
  });

  it('sweepPendingRequests() never throws (timer-safe)', () => {
    const { bot } = makeBot();
    bot.start();

    expect(() => bot.sweepPendingRequests()).not.toThrow();
    bot.stop();
  });

  it('a session-id mismatch is FATAL: stops the bot, fires onFatal, never carries on', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const onFatal = jest.fn();
    const { bot, client } = makeBot({
      logger,
      expectedBotSteamId: '76561199000000001',
      onFatal,
    });
    bot.start();

    client.steamID = { getSteamID64: () => '76561199000000999' };
    client.emit('loggedOn', {}, {});

    // Fail-fast, not log-and-carry-on: a wrong-account bot's next
    // friendsList snapshot would make reconcile read every active watch
    // as an opt-out and delete the base.
    expect(bot.isConnected()).toBe(false);
    expect(client.logOff).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    const reason = String(onFatal.mock.calls[0][0]);
    expect(reason).toContain('76561199000000999');
    expect(reason).toContain('76561199000000001');
    const errors = logger.error.mock.calls.map((call) => String(call[0]));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('STEAM_BOT_STEAMID mismatch'),
      ]),
    );
    expect(errors.join('\n')).toContain('76561199000000999');
    expect(errors.join('\n')).toContain('76561199000000001');
  });

  it('no reconnect is scheduled after a fatal mismatch (stopped, not backing off)', () => {
    const { bot, client } = makeBot({
      expectedBotSteamId: '76561199000000001',
      onFatal: jest.fn(),
    });
    bot.start();
    client.steamID = { getSteamID64: () => '76561199000000999' };
    client.emit('loggedOn', {}, {});

    // Any disconnect noise after the fatal stop must not resurrect the
    // session against the wrong account.
    client.emit('disconnected', 2, 'bye');
    jest.advanceTimersByTime(10_000);

    expect(client.logOn).toHaveBeenCalledTimes(1); // start() only
  });

  it('a stopped bot ignores friendsList snapshots (no reconcile fuel after a fatal mismatch)', () => {
    // The exact evidence for the fail-fast gap: the server's initial
    // friendsList sync typically lands inside the ~500ms window between
    // stop() and the host's process.exit — without the stopped guard it
    // would reconcile (and mass-deactivate) against the wrong account.
    const onFriendsSnapshot = jest.fn();
    const { bot, client } = makeBot({
      expectedBotSteamId: '76561199000000001',
      onFatal: jest.fn(),
      onFriendsSnapshot,
    });
    bot.start();
    client.steamID = { getSteamID64: () => '76561199000000999' };
    client.emit('loggedOn', {}, {});

    client.myFriends = { '76561198000000001': 3 };
    client.emit('friendsList');

    expect(onFriendsSnapshot).not.toHaveBeenCalled();
    // The offline-arrival sweep rides the same handler: no accept burst
    // against the wrong account either.
    expect(client.addFriend).not.toHaveBeenCalled();
  });

  it('a stopped bot ignores friendRelationship events (no removals/accepts post-fatal)', () => {
    const onFriendRemoved = jest.fn();
    const { bot, client } = makeBot({
      expectedBotSteamId: '76561199000000001',
      onFatal: jest.fn(),
      onFriendRemoved,
    });
    bot.start();
    client.steamID = { getSteamID64: () => '76561199000000999' };
    client.emit('loggedOn', {}, {});

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000001' },
      0, // None
    );
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000002' },
      2, // RequestRecipient
    );

    expect(onFriendRemoved).not.toHaveBeenCalled();
    expect(client.addFriend).not.toHaveBeenCalled();
  });

  it('a throwing onFatal is contained (the stop itself already ran)', () => {
    const { bot, client } = makeBot({
      expectedBotSteamId: '76561199000000001',
      onFatal: () => {
        throw new Error('exit hook broken');
      },
    });
    bot.start();
    client.steamID = { getSteamID64: () => '76561199000000999' };

    expect(() => client.emit('loggedOn', {}, {})).not.toThrow();
    expect(bot.isConnected()).toBe(false);
    expect(client.logOff).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the session id matches expectedBotSteamId (or is unreadable)', () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      logger,
      expectedBotSteamId: '76561199000000001',
    });
    // Drop the construction-time unwired-exit warning (covered by its own
    // tests): this test pins logon-time silence, not boot diagnostics.
    logger.error.mockClear();
    bot.start();

    client.steamID = { getSteamID64: () => '76561199000000001' };
    client.emit('loggedOn', {}, {});
    expect(
      logger.error.mock.calls.map((call) => String(call[0]).includes('mismatch')),
    ).not.toContain(true);

    // Unreadable session id: nothing to compare — silent, not evidence.
    client.steamID = null;
    client.emit('disconnected', 2, 'x');
    client.emit('loggedOn', {}, {});
    expect(
      logger.error.mock.calls.map((call) => String(call[0]).includes('mismatch')),
    ).not.toContain(true);
    bot.stop();
  });

  it('errors once at construction when the identity check is armed without onFatal', () => {
    // Safety net against incomplete wiring: without onFatal a mismatch
    // still stops the bot, but nothing exits the process (no supervisor
    // crash-loop alert). Error level (not info): a miswired identity
    // check deserves attention, and the message fires at most once per
    // boot, only when actually miswired.
    const logger = { info: jest.fn(), error: jest.fn() };
    makeBot({
      logger,
      expectedBotSteamId: '76561199000000001',
    });

    const errors = logger.error.mock.calls.map((call) => String(call[0]));
    expect(
      errors.some((line) => line.includes('without onFatal')),
    ).toBe(true);
  });

  it('stays quiet at construction when onFatal is wired or the check is off', () => {
    const wiredLogger = { info: jest.fn(), error: jest.fn() };
    makeBot({
      logger: wiredLogger,
      expectedBotSteamId: '76561199000000001',
      onFatal: jest.fn(),
    });
    const wiredErrors = wiredLogger.error.mock.calls.map((call) =>
      String(call[0]),
    );
    expect(
      wiredErrors.some((line) => line.includes('without onFatal')),
    ).toBe(false);

    const offLogger = { info: jest.fn(), error: jest.fn() };
    makeBot({ logger: offLogger });
    const offErrors = offLogger.error.mock.calls.map((call) =>
      String(call[0]),
    );
    expect(offErrors.some((line) => line.includes('without onFatal'))).toBe(
      false,
    );
  });

  it('dedupes the same steamId across a racing live event and sweep (one budget unit)', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      logger,
      // Budget 2: the sweep pre-check must PASS so the race reaches the
      // per-id dedupe (with 1 the sweep would pause first and never touch
      // the id — a different, already-covered path).
      autoAcceptDailyLimit: 2,
    });
    bot.start();

    // addFriend stays pending: the live accept below is still in flight
    // when the sweep runs into the same id.
    const pendingAccepts: Array<(value: unknown) => void> = [];
    client.addFriend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pendingAccepts.push(resolve);
        }),
    );
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000061' },
      2,
    );
    client.myFriends = { '76561198000000061': 2 };
    bot.sweepPendingRequests();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    // Exactly one addFriend despite two paths holding the id — and the
    // skip logged instead of burning the single daily unit twice.
    expect(client.addFriend).toHaveBeenCalledTimes(1);
    expect(
      logger.info.mock.calls.map((call) => String(call[0])),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('already in flight'),
      ]),
    );

    pendingAccepts.forEach((resolve) => resolve({ personaName: 'x' }));
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    // Owner converged; a later sweep for the same id proceeds normally
    // (no stuck dedupe entry).
    expect(client.addFriend).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it('an overlapping sweep stands down instead of piling up (timer race guard)', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({ logger });
    bot.start();

    const resolvers: Array<(value: unknown) => void> = [];
    client.addFriend.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    client.myFriends = {
      '76561198000000071': 2,
      '76561198000000072': 2,
    };
    bot.sweepPendingRequests();
    // Second pass while the first is still awaiting Steam: stands down.
    bot.sweepPendingRequests();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(
      logger.info.mock.calls.map((call) => String(call[0])),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('already in flight'),
      ]),
    );
    resolvers.forEach((resolve) => resolve({ personaName: 'x' }));
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    // Each id accepted exactly once — no double-processing pileup.
    expect(client.addFriend).toHaveBeenCalledTimes(2);
    bot.stop();
  });

  it('a cross-midnight failure refund never perturbs the fresh day\'s budget', async () => {
    let now = Date.parse('2026-09-01T23:59:59.000Z');
    const logger = { info: jest.fn(), error: jest.fn() };
    const { bot, client } = makeBot({
      logger,
      autoAcceptDailyLimit: 1,
      nowMs: () => now,
    });
    bot.start();

    // Day A: an accept reserves the last slot, then hangs on Steam.
    const pendingRejects: Array<(reason?: unknown) => void> = [];
    client.addFriend.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          pendingRejects.push(reject);
        }),
    );
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000081' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    // UTC day rolls over; a fresh accept on day B consumes ITS only slot.
    now = Date.parse('2026-09-02T00:00:05.000Z');
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000082' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(client.addFriend).toHaveBeenCalledTimes(2);

    // Day A's hung accept NOW fails: the refund must NOT decrement day
    // B's counter (old behavior: B would read 0 and admit an extra accept).
    pendingRejects[0](new Error('Steam hiccup'));
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    // Day B is still at its limit: a new request is refused, not admitted
    // on top of the cross-midnight refund.
    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000083' },
      2,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(client.addFriend).toHaveBeenCalledTimes(2);
    expect(
      logger.error.mock.calls.map((call) => String(call[0])),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('daily accept budget exhausted'),
      ]),
    );
    bot.stop();
  });

  it('never accepts outgoing pending invites (RequestInitiator)', async () => {
    const onFriendRemoved = jest.fn();
    const { bot, client } = makeBot({ onFriendRemoved });
    bot.start();

    client.emit(
      'friendRelationship',
      { getSteamID64: () => '76561198000000004' },
      4,
    );
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(client.addFriend).not.toHaveBeenCalled();
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

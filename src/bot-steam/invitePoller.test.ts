import { pollInviteQueueOnce, startInvitePoller } from './invitePoller';

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const silentLogger = { info: jest.fn(), error: jest.fn() };

type FakeEvent = { id: number; steamId: string };

const makeDal = () => ({
  claimNextQueuedEvents: jest.fn(async (): Promise<FakeEvent[]> => []),
  markEventSent: jest.fn(async (): Promise<boolean> => true),
  recordEventAttempt: jest.fn(
    async (): Promise<'requeued' | 'dropped' | null> => 'requeued',
  ),
  countInvitesSentSince: jest.fn(async (): Promise<number> => 0),
});

const makeClient = () => ({
  addFriend: jest.fn(async (): Promise<unknown> => ({ personaName: 'x' })),
});

const inviteEvent = (id: number, steamId: string) => ({ id, steamId });

describe('pollInviteQueueOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims, invites, marks sent, and logs a summary', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([
      inviteEvent(1, STEAM_A),
      inviteEvent(2, STEAM_B),
    ]);

    const report = await pollInviteQueueOnce({
      client,
      dal,
      logger,
      batchLimit: 10,
      maxAttempts: 3,
    });

    expect(report).toMatchObject({ claimed: 2, sent: 2, errors: [] });
    expect(client.addFriend).toHaveBeenCalledWith(STEAM_A);
    expect(client.addFriend).toHaveBeenCalledWith(STEAM_B);
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0][0])).toContain('claimed=2');
  });

  it('requeues on transient addFriend failure and keeps going', async () => {
    const dal = makeDal();
    const client = makeClient();
    dal.claimNextQueuedEvents.mockResolvedValue([
      inviteEvent(1, STEAM_A),
      inviteEvent(2, STEAM_B),
    ]);
    client.addFriend.mockRejectedValueOnce(new Error('rate limited'));

    const report = await pollInviteQueueOnce({
      client,
      dal,
      logger: silentLogger,
      maxAttempts: 3,
    });

    expect(report).toMatchObject({
      claimed: 2,
      sent: 1,
      retried: 1,
      dropped: 0,
    });
    expect(dal.recordEventAttempt).toHaveBeenCalledWith(1, 3);
    expect(dal.markEventSent).toHaveBeenCalledTimes(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(2);
  });

  it('drops after maxAttempts with a loud log', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(7, STEAM_A)]);
    client.addFriend.mockRejectedValue(new Error('still failing'));
    dal.recordEventAttempt.mockResolvedValue('dropped');

    const report = await pollInviteQueueOnce({
      client,
      dal,
      logger,
      maxAttempts: 3,
    });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(dal.markEventSent).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain(STEAM_A);
  });

  it('never re-sends when the send succeeded but bookkeeping keeps failing', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(1, STEAM_A)]);
    dal.markEventSent.mockRejectedValue(new Error('db timeout'));

    const report = await pollInviteQueueOnce({
      client,
      dal,
      logger,
      maxAttempts: 3,
    });

    // addFriend exactly once (no duplicate invite), mark retried, then a
    // loud special-case error — and crucially NO recordEventAttempt (which
    // would requeue and re-send).
    expect(client.addFriend).toHaveBeenCalledTimes(1);
    expect(dal.markEventSent).toHaveBeenCalledTimes(3);
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      claimed: 1,
      sent: 0,
      dropped: 0,
      retried: 0,
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].message).toContain('sent but not recorded');
    expect(String(logger.error.mock.calls[0][0])).toContain(STEAM_A);
  });
  it('does nothing on an empty queue', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };

    const report = await pollInviteQueueOnce({ client, dal, logger });

    expect(report).toMatchObject({ claimed: 0, sent: 0, errors: [] });
    expect(client.addFriend).not.toHaveBeenCalled();
    // Quiet on empty passes (liveness is the heartbeat's job, not the
    // poller's) — no summary line for zero work.
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('records (not hides) a vanished row or a bookkeeping failure', async () => {
    const dal = makeDal();
    const client = makeClient();
    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(1, STEAM_A)]);
    client.addFriend.mockRejectedValueOnce(new Error('nope'));
    dal.recordEventAttempt.mockResolvedValueOnce(null);

    const first = await pollInviteQueueOnce({ client, dal });
    expect(first.errors).toHaveLength(1);

    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(2, STEAM_B)]);
    client.addFriend.mockRejectedValueOnce(new Error('nope'));
    dal.recordEventAttempt.mockRejectedValueOnce(new Error('db down'));

    const second = await pollInviteQueueOnce({ client, dal });
    expect(second.errors).toHaveLength(1);
  });

  it('logs each failed event individually, not just the count', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(1, STEAM_A)]);
    client.addFriend.mockRejectedValueOnce(new Error('boom'));
    dal.recordEventAttempt.mockResolvedValueOnce(null);

    const report = await pollInviteQueueOnce({ client, dal, logger });

    expect(report.errors).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('eventId=1');
    expect(String(logger.error.mock.calls[0][0])).toContain('boom');
  });

  it('skips the whole pass (no DAL, no Steam) when not connected', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };

    const report = await pollInviteQueueOnce({
      client,
      dal,
      logger,
      isConnected: () => false,
    });

    expect(report.skipped).toBe(true);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
    expect(client.addFriend).not.toHaveBeenCalled();
  });

  it('fails fast on invalid maxAttempts', async () => {
    const dal = makeDal();
    const client = makeClient();

    await expect(
      pollInviteQueueOnce({ client, dal, maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
  });

  it('skips claiming (nothing sent) when the daily cap is already reached', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.countInvitesSentSince.mockResolvedValue(50);

    const report = await pollInviteQueueOnce({
      client,
      dal,
      logger,
      dailyLimit: 50,
    });

    expect(report.skipped).toBe(true);
    expect(report).toMatchObject({ claimed: 0, sent: 0 });
    // The cap is checked BEFORE claiming: a capped pass must not claim
    // rows it will not send (they would sit claimed until the stale sweep).
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
    expect(client.addFriend).not.toHaveBeenCalled();
    expect(String(logger.info.mock.calls[0][0])).toContain('daily send cap');
  });

  it('sends while under the cap, counting from UTC midnight', async () => {
    const dal = makeDal();
    const client = makeClient();
    dal.countInvitesSentSince.mockResolvedValue(49);
    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(1, STEAM_A)]);

    const report = await pollInviteQueueOnce({
      client,
      dal,
      dailyLimit: 50,
    });

    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    expect(dal.countInvitesSentSince).toHaveBeenCalledTimes(1);
    expect(dal.countInvitesSentSince).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/),
    );
    // Clamped to the REMAINING budget (1), not the full batch (5): a pass
    // starting at 49/50 must send exactly 1, never overshoot to 54.
    expect(dal.claimNextQueuedEvents).toHaveBeenCalledWith('invite', 1);
  });

  it('claims the full batch while the remaining budget covers it', async () => {
    const dal = makeDal();
    const client = makeClient();
    dal.countInvitesSentSince.mockResolvedValue(0);

    await pollInviteQueueOnce({
      client,
      dal,
      batchLimit: 5,
      dailyLimit: 50,
    });

    expect(dal.claimNextQueuedEvents).toHaveBeenCalledWith('invite', 5);
  });

  it('fails fast on invalid dailyLimit', async () => {
    const dal = makeDal();
    const client = makeClient();

    await expect(
      pollInviteQueueOnce({ client, dal, dailyLimit: 0 }),
    ).rejects.toThrow(/dailyLimit/);
    expect(dal.countInvitesSentSince).not.toHaveBeenCalled();
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
  });

  it('counts (never sends-again) when the row leaves claimed state mid-send', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([inviteEvent(1, STEAM_A)]);
    // Send went through, but the row is gone from claimed (e.g. a stale
    // sweep requeued it mid-send): settling reports false.
    dal.markEventSent.mockResolvedValue(false);

    const report = await pollInviteQueueOnce({ client, dal, logger });

    expect(client.addFriend).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ claimed: 1, sent: 0 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].message).toContain('claimed state');
    // No retry of the send, no requeue discipline: exactly one addFriend.
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
  });
});

describe('startInvitePoller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not poll on start; polls on the interval until stopped', async () => {
    const dal = makeDal();
    const client = makeClient();

    const handle = startInvitePoller({
      client,
      dal,
      pollIntervalMs: 60000,
    });
    try {
      expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();

      const pending = handle.pollOnce();
      // pollOnce runs the pass immediately (not on the timer).
      await pending;
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(120000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(3);

      handle.stop();
      await jest.advanceTimersByTimeAsync(600000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(3);
    } finally {
      handle.stop();
    }
  });

  it('throws on invalid interval without scheduling anything', () => {
    const dal = makeDal();
    const client = makeClient();

    expect(() => startInvitePoller({ client, dal, pollIntervalMs: 0 })).toThrow(
      /interval/,
    );
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
  });

  it('never runs two passes concurrently (slow pass skips ticks)', async () => {
    const dal = makeDal();
    const client = makeClient();
    let release!: (rows: Array<{ id: number; steamId: string }>) => void;
    dal.claimNextQueuedEvents.mockImplementation(
      () =>
        new Promise<Array<{ id: number; steamId: string }>>((resolve) => {
          release = resolve;
        }),
    );

    const handle = startInvitePoller({
      client,
      dal,
      logger: silentLogger,
      pollIntervalMs: 60000,
    });
    try {
      await jest.advanceTimersByTimeAsync(60000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      // Second tick fires while the first pass is still hung on claim —
      // the guard must skip it instead of stacking a parallel pass.
      await jest.advanceTimersByTimeAsync(60000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      release([]);
      await jest.advanceTimersByTimeAsync(60000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(2);
    } finally {
      handle.stop();
    }
  });

  it('an external pollOnce also respects the guard (no interval stacking)', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    let release!: (rows: Array<{ id: number; steamId: string }>) => void;
    dal.claimNextQueuedEvents.mockImplementation(
      () =>
        new Promise<Array<{ id: number; steamId: string }>>((resolve) => {
          release = resolve;
        }),
    );

    const handle = startInvitePoller({
      client,
      dal,
      logger,
      pollIntervalMs: 60000,
    });
    try {
      // External first pass (the index.ts startup path), hung on claim.
      const first = handle.pollOnce();

      // Interval tick fires mid-pass: must skip, not stack.
      await jest.advanceTimersByTimeAsync(60000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      release([]);
      const firstReport = await first;
      expect(firstReport.skipped).toBe(false);

      // Next tick proceeds normally once the previous pass settled.
      await jest.advanceTimersByTimeAsync(60000);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(2);
    } finally {
      handle.stop();
    }
  });

  it('a skipped pass reports skipped:true instead of running', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    let release!: (rows: Array<{ id: number; steamId: string }>) => void;
    dal.claimNextQueuedEvents.mockImplementation(
      () =>
        new Promise<Array<{ id: number; steamId: string }>>((resolve) => {
          release = resolve;
        }),
    );

    const handle = startInvitePoller({
      client,
      dal,
      logger,
      pollIntervalMs: 60000,
    });
    try {
      const first = handle.pollOnce();
      const skipped = await handle.pollOnce();

      expect(skipped.skipped).toBe(true);
      expect(skipped.claimed).toBe(0);
      expect(dal.claimNextQueuedEvents).toHaveBeenCalledTimes(1);

      release([]);
      await first;
    } finally {
      handle.stop();
    }
  });

  it('a hung addFriend fails visibly via watchdog instead of wedging the pass', async () => {
    const dal = makeDal();
    const client = makeClient();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    // Never settles: without the watchdog this pass would hang forever.
    client.addFriend.mockImplementation(() => new Promise(() => {}));

    const reportPromise = pollInviteQueueOnce({
      client,
      dal,
      logger,
      sendTimeoutMs: 50,
      maxAttempts: 3,
    });
    await jest.advanceTimersByTimeAsync(50);

    const report = await reportPromise;
    expect(report).toMatchObject({ claimed: 1, sent: 0 });
    expect(dal.recordEventAttempt).toHaveBeenCalledWith(1, 3);
  });
});

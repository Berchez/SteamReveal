import { getWelcomeMessage } from './welcomeMessage';
import { pollWelcomeQueueOnce, startWelcomePoller } from './welcomePoller';

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const silentLogger = { info: jest.fn(), error: jest.fn() };

type FakeEvent = { id: number; steamId: string };

const makeDal = () => ({
  claimNextQueuedEvents: jest.fn(async (): Promise<FakeEvent[]> => []),
  markEventSent: jest.fn(async (): Promise<boolean> => true),
  markEventDropped: jest.fn(async (): Promise<boolean> => true),
  recordEventAttempt: jest.fn(
    async (): Promise<'requeued' | 'dropped' | null> => 'requeued',
  ),
  getWatchedProfile: jest.fn(
    async (): Promise<{
      status: string;
      locale: string | null;
    } | null> => ({ status: 'active', locale: 'en' }),
  ),
});

const makeChat = () => ({
  sendFriendMessage: jest.fn(async (): Promise<unknown> => ({ ordinal: 1 })),
});

describe('pollWelcomeQueueOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims welcomes, sends the localized message, marks sent', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([
      { id: 1, steamId: STEAM_A },
      { id: 2, steamId: STEAM_B },
    ]);
    dal.getWatchedProfile
      .mockResolvedValueOnce({ status: 'active', locale: 'pt' })
      .mockResolvedValueOnce({ status: 'active', locale: 'de' });

    const report = await pollWelcomeQueueOnce({ chat, dal, logger });

    // Lane isolation: the welcome poller only ever claims its own lane.
    expect(dal.claimNextQueuedEvents).toHaveBeenCalledWith('welcome', 10);
    expect(report).toMatchObject({ claimed: 2, sent: 2, errors: [] });
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_A,
      getWelcomeMessage('pt'),
    );
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_B,
      getWelcomeMessage('de'),
    );
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0][0])).toContain('claimed=2');
  });

  it('drops events whose watch row is gone or not active (never messages)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([
      { id: 1, steamId: STEAM_A },
      { id: 2, steamId: STEAM_B },
    ]);
    dal.getWatchedProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'pending', locale: 'en' });

    const report = await pollWelcomeQueueOnce({
      chat,
      dal,
      logger: silentLogger,
    });

    expect(report).toMatchObject({ claimed: 2, sent: 0, dropped: 2 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
    expect(dal.markEventDropped).toHaveBeenCalledWith(2);
  });

  it('retries send failures and drops at the attempt cap', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.recordEventAttempt.mockResolvedValueOnce('requeued');

    const retried = await pollWelcomeQueueOnce({
      chat,
      dal,
      logger: silentLogger,
    });
    expect(retried).toMatchObject({ retried: 1, dropped: 0 });

    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.recordEventAttempt.mockResolvedValueOnce('dropped');
    const dropped = await pollWelcomeQueueOnce({
      chat,
      dal,
      logger: silentLogger,
    });
    expect(dropped).toMatchObject({ retried: 0, dropped: 1 });
  });

  it('reports sent-but-not-recorded without requeueing (no duplicate)', async () => {
    // sendFriendMessage succeeded but every settle mark throws: the row
    // stays claimed (stale sweep requeues as a last resort) and the pass
    // must NOT call recordEventAttempt (that would re-send for sure).
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.markEventSent.mockRejectedValue(new Error('turso blip'));

    const report = await pollWelcomeQueueOnce({
      chat,
      dal,
      logger: silentLogger,
    });

    expect(report).toMatchObject({ sent: 0 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      eventId: 1,
      message: expect.stringContaining('sent but not recorded'),
    });
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
  });

  it('skips the whole pass when disconnected (no DAL/chat touched)', async () => {
    const dal = makeDal();
    const chat = makeChat();

    const report = await pollWelcomeQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isConnected: () => false,
    });

    expect(report.skipped).toBe(true);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });

  it('throws on invalid maxAttempts (fail fast, never a silent no-op)', async () => {
    const dal = makeDal();
    const chat = makeChat();

    await expect(
      pollWelcomeQueueOnce({ chat, dal, maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
  });
});

describe('startWelcomePoller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws on invalid intervals (fail fast at wiring time)', () => {
    const dal = makeDal();
    const chat = makeChat();

    expect(() =>
      startWelcomePoller({ chat, dal, pollIntervalMs: 0 }),
    ).toThrow(/interval/);
  });

  it('skips overlapping passes (no stacked chat bursts)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    let releaseClaim!: () => void;
    dal.claimNextQueuedEvents.mockImplementation(
      () =>
        new Promise<FakeEvent[]>((resolve) => {
          releaseClaim = () => resolve([]);
        }),
    );
    const handle = startWelcomePoller({
      chat,
      dal,
      logger: silentLogger,
      pollIntervalMs: 60000,
    });

    const first = handle.pollOnce();
    const second = await handle.pollOnce();

    expect(second.skipped).toBe(true);
    releaseClaim();
    const done = await first;
    expect(done.skipped).toBe(false);
    handle.stop();
  });
});

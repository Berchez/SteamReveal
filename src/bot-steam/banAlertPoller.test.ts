import { getBanAlertMessage } from './banAlertMessage';
import { pollBanAlertQueueOnce, startBanAlertPoller } from './banAlertPoller';

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
  getBanSubscriptionForAlert: jest.fn(
    async (): Promise<{ locale: string | null } | null> => ({
      locale: 'en',
    }),
  ),
});

const makeChat = () => ({
  sendFriendMessage: jest.fn(
    async (_steamId: string, _message: string): Promise<unknown> => ({
      ordinal: 1,
    }),
  ),
});

const friendOf = (id: string) => (steamId: string) => steamId === id;

describe('pollBanAlertQueueOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims ban_alerts, sends the generic message, marks sent', async () => {
    const dal = makeDal();
    const chat = makeChat();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([
      { id: 1, steamId: STEAM_A },
      { id: 2, steamId: STEAM_B },
    ]);
    dal.getBanSubscriptionForAlert
      .mockResolvedValueOnce({ locale: 'pt' })
      .mockResolvedValueOnce({ locale: 'de' });

    const report = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger,
      isFriend: () => true,
    });

    // Lane isolation: the ban-alert poller only ever claims its own lane.
    expect(dal.claimNextQueuedEvents).toHaveBeenCalledWith('ban_alert', 10);
    expect(report).toMatchObject({ claimed: 2, sent: 2, errors: [] });
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_A,
      getBanAlertMessage('pt'),
    );
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_B,
      getBanAlertMessage('de'),
    );
    // Generic by design: the chat text never names a profile.
    expect(chat.sendFriendMessage.mock.calls[0][1]).not.toContain(STEAM_A);
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(2);
  });

  it('drops events whose subscription row is gone (never messages)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getBanSubscriptionForAlert.mockResolvedValueOnce(null);

    const report = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isFriend: () => true,
    });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
  });

  it('drops the chat send for non-friends (inbox stays — visibility is subscription-side)', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);

    const report = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isFriend: friendOf(STEAM_B),
    });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
    // Never retried: friendship may arrive days later; a TTL-less requeue
    // would spin until the attempt cap for nothing.
    expect(dal.recordEventAttempt).not.toHaveBeenCalled();
  });

  it('retries then drops at the cap; sent-but-not-recorded never requeues', async () => {
    const dal = makeDal();
    const chat = makeChat();
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.recordEventAttempt.mockResolvedValueOnce('requeued');

    const retried = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isFriend: () => true,
    });
    expect(retried).toMatchObject({ retried: 1, dropped: 0 });

    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.recordEventAttempt.mockResolvedValueOnce('dropped');
    const dropped = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isFriend: () => true,
    });
    expect(dropped).toMatchObject({ dropped: 1 });

    // Send succeeded but settle failed: loud error, NO requeue (would duplicate).
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 2, steamId: STEAM_B }]);
    chat.sendFriendMessage.mockResolvedValueOnce({ ordinal: 1 });
    dal.markEventSent.mockResolvedValueOnce(false);
    const lost = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isFriend: () => true,
    });
    expect(lost.errors.length).toBe(1);
    expect(dal.recordEventAttempt).not.toHaveBeenCalledWith(
      2,
      expect.anything(),
    );
  });

  it('skips without touching DAL/chat when not connected', async () => {
    const dal = makeDal();
    const chat = makeChat();

    const report = await pollBanAlertQueueOnce({
      chat,
      dal,
      logger: silentLogger,
      isConnected: () => false,
      isFriend: () => true,
    });

    expect(report.skipped).toBe(true);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });

  it('validates maxAttempts and the interval driver guards overlaps', async () => {
    const dal = makeDal();
    const chat = makeChat();
    await expect(
      pollBanAlertQueueOnce({
        chat,
        dal,
        maxAttempts: 0,
        isFriend: () => true,
      }),
    ).rejects.toThrow(/maxAttempts/);
    expect(() =>
      startBanAlertPoller({
        chat,
        dal,
        pollIntervalMs: 0,
        isFriend: () => true,
      }),
    ).toThrow(/positive/);

    dal.claimNextQueuedEvents.mockImplementation(
      () => new Promise<FakeEvent[]>(() => undefined),
    );
    const poller = startBanAlertPoller({
      chat,
      dal,
      pollIntervalMs: 60000,
      logger: silentLogger,
      isFriend: () => true,
    });
    const first = poller.pollOnce();
    const second = await poller.pollOnce();
    expect(second.skipped).toBe(true);
    poller.stop();
    void first.catch(() => undefined);
  });
});

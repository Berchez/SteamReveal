import type { WatchAccount } from '../lib/analytics/types';
import {
  pollConfirmResendQueueOnce,
  startConfirmResendPoller,
} from './confirmResendPoller';

const STEAM_A = '76561198000000001';

const silentLogger = { info: jest.fn(), error: jest.fn() };

const HOUR_MS = 3600000;
const TTL_MS = 24 * HOUR_MS;

const pendingProfile = (locale: string | null = 'pt') => ({
  status: 'pending',
  locale,
});

const unconfirmedAccount = (overrides = {}) => ({
  steamId: STEAM_A,
  createdAt: '2026-09-01T00:00:00.000Z',
  confirmedAt: null,
  confirmTokenHash: null,
  confirmExpiresAt: null,
  locale: null,
  ...overrides,
});

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
    } | null> => null,
  ),
  getAccount: jest.fn(async (): Promise<WatchAccount | null> => null),
  issueConfirmToken: jest.fn(async (): Promise<boolean> => true),
  clearConfirmToken: jest.fn(async (): Promise<boolean> => true),
});

const makeChat = () => ({
  sendFriendMessage: jest.fn(async (): Promise<unknown> => ({ ordinal: 1 })),
});

const SITE = 'https://reveal.example';

const baseOptions = (dal: ReturnType<typeof makeDal>) => ({
  chat: makeChat(),
  dal,
  logger: silentLogger,
  siteUrl: SITE,
  confirmTokenTtlMs: TTL_MS,
  isFriend: () => true,
});

describe('pollConfirmResendQueueOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues a fresh link and sends it for eligible requests', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile('es'));
    dal.getAccount.mockResolvedValue(unconfirmedAccount());

    const report = await pollConfirmResendQueueOnce({ chat, ...rest });

    // Lane isolation: only its own lane is ever claimed.
    expect(dal.claimNextQueuedEvents).toHaveBeenCalledWith(
      'confirm_resend',
      10,
    );
    expect(report).toMatchObject({ claimed: 1, sent: 1, errors: [] });
    expect(dal.issueConfirmToken).toHaveBeenCalledTimes(1);
    // The DAL hash derives from the exact token embedded in the link.
    const [issuedId, hash, linkExpiresAt] = (
      dal.issueConfirmToken as jest.Mock
    ).mock.calls[0];
    expect(issuedId).toBe(STEAM_A);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(linkExpiresAt) - Date.now()).toBeGreaterThan(
      23 * HOUR_MS,
    );
    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    const [sentId, message] = (chat.sendFriendMessage as jest.Mock).mock
      .calls[0];
    expect(sentId).toBe(STEAM_A);
    expect(message).toContain(`${SITE}/api/watch/confirm?token=`);
    expect(dal.markEventSent).toHaveBeenCalledWith(1);
  });

  it.each([
    { status: null as string | null, reason: 'watch-gone' },
    { status: 'active', reason: 'watch-not-pending' },
  ])('drops $reason requests without messaging', async ({ status, reason }) => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(
      status === null ? null : { status, locale: 'en' },
    );
    dal.getAccount.mockResolvedValue(unconfirmedAccount());

    const report = await pollConfirmResendQueueOnce({
      chat,
      dal,
      logger,
      siteUrl: SITE,
      confirmTokenTtlMs: TTL_MS,
      isFriend: () => true,
    });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.issueConfirmToken).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
    expect(String(logger.info.mock.calls[0][0])).toContain(
      `reason=${reason}`,
    );
  });

  it.each([{ reason: 'no-account' }, { reason: 'already-confirmed' }])(
    'drops $reason requests (confirm route owns confirmed users)',
    async ({ reason }) => {
      const dal = makeDal();
      const { chat, ...rest } = baseOptions(dal);
      dal.claimNextQueuedEvents.mockResolvedValue([
        { id: 1, steamId: STEAM_A },
      ]);
      dal.getWatchedProfile.mockResolvedValue(pendingProfile());
      dal.getAccount.mockResolvedValue(
        reason === 'no-account'
          ? null
          : unconfirmedAccount({ confirmedAt: '2026-09-03T00:00:00.000Z' }),
      );

      const report = await pollConfirmResendQueueOnce({ chat, ...rest });

      expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
      expect(chat.sendFriendMessage).not.toHaveBeenCalled();
      expect(dal.issueConfirmToken).not.toHaveBeenCalled();
    },
  );

  it('requeues (never drops) when friendship is unknown yet, drops at the cap', async () => {
    // Startup race: myFriends may not be loaded on the first post-logon
    // pass. An explicit user request must not die on that transient — it
    // retries, and only a persistent non-friendship (real unfriend) drops
    // at the attempt cap (reconcile removes those rows anyway).
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    dal.recordEventAttempt.mockResolvedValueOnce('requeued');

    const retried = await pollConfirmResendQueueOnce({
      chat,
      ...rest,
      isFriend: () => false,
    });

    expect(retried).toMatchObject({ claimed: 1, sent: 0, dropped: 0 });
    expect(retried.retried).toBe(1);
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.issueConfirmToken).not.toHaveBeenCalled();

    dal.recordEventAttempt.mockResolvedValueOnce('dropped');
    const dropped = await pollConfirmResendQueueOnce({
      chat,
      ...rest,
      isFriend: () => false,
    });

    expect(dropped).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });

  it('throttles re-issues inside the floor, allows past it', async () => {
    const issuedOneMinuteAgo = new Date(Date.now() - 60000).toISOString();
    const liveExpiry = new Date(
      Date.parse(issuedOneMinuteAgo) + TTL_MS,
    ).toISOString();
    const issuedTwoHoursAgo = new Date(
      Date.now() - 2 * HOUR_MS,
    ).toISOString();
    const oldLiveExpiry = new Date(
      Date.parse(issuedTwoHoursAgo) + TTL_MS,
    ).toISOString();

    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([
      { id: 1, steamId: STEAM_A },
      { id: 2, steamId: STEAM_A },
    ]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount
      .mockResolvedValueOnce(
        unconfirmedAccount({
          confirmTokenHash: 'ab'.repeat(32),
          confirmExpiresAt: liveExpiry,
        }),
      )
      .mockResolvedValueOnce(
        unconfirmedAccount({
          confirmTokenHash: 'cd'.repeat(32),
          confirmExpiresAt: oldLiveExpiry,
        }),
      );

    const report = await pollConfirmResendQueueOnce({ chat, ...rest });

    // Fresh live token: throttled (a link is already on its way). Old
    // live token: re-issued (probably lost), killing the previous one.
    expect(report).toMatchObject({ claimed: 2, sent: 1, dropped: 1 });
    expect(dal.issueConfirmToken).toHaveBeenCalledTimes(1);
    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
    expect(dal.markEventSent).toHaveBeenCalledWith(2);
  });

  it('drops quietly when the issue loses a confirm race (route owns it)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    dal.issueConfirmToken.mockResolvedValue(false);

    const report = await pollConfirmResendQueueOnce({ chat, ...rest });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markEventDropped).toHaveBeenCalledWith(1);
  });

  it('retries send failures and drops at the attempt cap', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.recordEventAttempt.mockResolvedValueOnce('requeued');

    const retried = await pollConfirmResendQueueOnce({ chat, ...rest });
    expect(retried).toMatchObject({ retried: 1, dropped: 0 });

    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.recordEventAttempt.mockResolvedValueOnce('dropped');
    const dropped = await pollConfirmResendQueueOnce({ chat, ...rest });
    expect(dropped).toMatchObject({ retried: 0, dropped: 1 });
  });

  it('rolls back the issued token when the chat send fails (no dead-token lockout)', async () => {
    // The P1 scenario, pinned: issueConfirmToken commits, then
    // sendFriendMessage throws. Before the rollback the hash stayed —
    // the UI showed "check your Steam chat" (confirmLinkSent derives
    // from hash presence) while every retry died in the throttle, which
    // derives issue time from the dead token's expiry.
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));

    const report = await pollConfirmResendQueueOnce({ chat, ...rest });

    expect(report).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    // Compare-and-delete with the exact hash this pass issued.
    const issuedHash = (dal.issueConfirmToken as jest.Mock).mock.calls[0][1];
    expect(dal.clearConfirmToken).toHaveBeenCalledTimes(1);
    expect(dal.clearConfirmToken).toHaveBeenCalledWith(STEAM_A, issuedHash);
    // Requeued (not throttled-dropped): the retry path stays alive.
    expect(dal.recordEventAttempt).toHaveBeenCalledWith(1, 3);
    expect(dal.markEventDropped).not.toHaveBeenCalled();
  });

  it('recovers on the next pass after a failed send (rollback defeats the throttle)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));

    const first = await pollConfirmResendQueueOnce({ chat, ...rest });
    expect(first).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    expect(dal.clearConfirmToken).toHaveBeenCalledTimes(1);

    // Next pass, post-rollback state (hash gone): the throttle block is
    // skipped and a fresh token goes out — no 'throttled' drop.
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    const second = await pollConfirmResendQueueOnce({ chat, ...rest });
    expect(second).toMatchObject({ claimed: 1, sent: 1 });
    expect(dal.markEventDropped).not.toHaveBeenCalled();
    expect(dal.issueConfirmToken).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed rollback loud (chained message survives to the drop log)', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };
    const { chat } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));
    dal.clearConfirmToken.mockRejectedValueOnce(new Error('turso down'));
    dal.recordEventAttempt.mockResolvedValueOnce('dropped');

    const report = await pollConfirmResendQueueOnce({
      chat,
      dal,
      logger,
      siteUrl: SITE,
      confirmTokenTtlMs: TTL_MS,
      isFriend: () => true,
    });

    expect(report).toMatchObject({ claimed: 1, sent: 0, dropped: 1 });
    const logged = logger.error.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('chat down'))).toBe(true);
    expect(logged.some((line) => line.includes('rollback failed'))).toBe(true);
    expect(logged.some((line) => line.includes('turso down'))).toBe(true);
  });

  it('never rolls anything back on the happy path (a delivered link keeps its hash)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.claimNextQueuedEvents.mockResolvedValue([{ id: 1, steamId: STEAM_A }]);
    dal.getWatchedProfile.mockResolvedValue(pendingProfile());
    dal.getAccount.mockResolvedValue(unconfirmedAccount());

    const report = await pollConfirmResendQueueOnce({ chat, ...rest });

    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    expect(dal.clearConfirmToken).not.toHaveBeenCalled();
  });

  it('skips the whole pass when disconnected (no DAL/chat touched)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);

    const report = await pollConfirmResendQueueOnce({
      chat,
      ...rest,
      isConnected: () => false,
    });

    expect(report.skipped).toBe(true);
    expect(dal.claimNextQueuedEvents).not.toHaveBeenCalled();
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });

  it('throws on invalid options (fail fast, never a silent no-op)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);

    await expect(
      pollConfirmResendQueueOnce({ chat, ...rest, maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
    await expect(
      pollConfirmResendQueueOnce({ chat, ...rest, siteUrl: '' }),
    ).rejects.toThrow(/siteUrl/);
  });
});

describe('startConfirmResendPoller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws on invalid intervals (fail fast at wiring time)', () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);

    expect(() =>
      startConfirmResendPoller({ chat, ...rest, pollIntervalMs: 0 }),
    ).toThrow(/interval/);
  });
});

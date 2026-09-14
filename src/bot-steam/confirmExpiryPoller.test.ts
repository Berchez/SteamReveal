import type {
  ExpiredConfirmCandidate,
  WatchAccount,
} from '../lib/analytics/types';
import { getConfirmExpiredText } from '../lib/watch/notificationText';
import {
  pollConfirmExpiryOnce,
  startConfirmExpiryPoller,
} from './confirmExpiryPoller';

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';
const EXPIRED = '2000-01-01T00:00:00.000Z';

const silentLogger = { info: jest.fn(), error: jest.fn() };

const candidate = (steamId: string, expiresAt: string = EXPIRED) => ({
  steamId,
  watchLocale: 'pt' as string | null,
  accountLocale: null as string | null,
  expiresAt,
});

const unconfirmedAccount = (expiresAt: string = EXPIRED) => ({
  steamId: STEAM_A,
  createdAt: EXPIRED,
  confirmedAt: null,
  confirmTokenHash: 'ab'.repeat(32),
  confirmExpiresAt: expiresAt,
  locale: null,
});

const makeDal = () => ({
  listExpiredUnnoticedConfirms: jest.fn(
    async (): Promise<ExpiredConfirmCandidate[]> => [],
  ),
  getAccount: jest.fn(async (): Promise<WatchAccount | null> => null),
  markExpireNoticed: jest.fn(async (): Promise<boolean> => true),
});

const makeChat = () => ({
  sendFriendMessage: jest.fn(async (): Promise<unknown> => ({ ordinal: 1 })),
});

const baseOptions = (dal: ReturnType<typeof makeDal>) => ({
  chat: makeChat(),
  dal,
  logger: silentLogger,
  isFriend: () => true,
});

describe('pollConfirmExpiryOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('notifies expired-unconfirmed friends once and marks the generation', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([
      candidate(STEAM_A),
      candidate(STEAM_B),
    ]);
    dal.getAccount.mockResolvedValue(unconfirmedAccount());

    const report = await pollConfirmExpiryOnce({ chat, ...rest });

    expect(dal.listExpiredUnnoticedConfirms).toHaveBeenCalledWith(10);
    expect(report).toMatchObject({ checked: 2, notified: 2, skipped: 0 });
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_A,
      getConfirmExpiredText('pt'),
    );
    expect(dal.markExpireNoticed).toHaveBeenCalledWith(STEAM_A, EXPIRED);
    expect(dal.markExpireNoticed).toHaveBeenCalledWith(STEAM_B, EXPIRED);
  });

  it('skips non-friends silently (no channel; reconcile owns those rows)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([candidate(STEAM_A)]);

    const report = await pollConfirmExpiryOnce({
      chat,
      ...rest,
      isFriend: () => false,
    });

    expect(report).toMatchObject({ checked: 1, notified: 0, skipped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markExpireNoticed).not.toHaveBeenCalled();
  });

  it('never nags a user who clicked (confirmed on recheck)', async () => {
    // THE guarantee: a click landing between the scan and this pass must
    // not produce a message — the listing alone never authorizes a send.
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([candidate(STEAM_A)]);
    dal.getAccount.mockResolvedValue({
      ...unconfirmedAccount(),
      confirmedAt: '2026-09-03T00:00:00.000Z',
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });

    const report = await pollConfirmExpiryOnce({ chat, ...rest });

    expect(report).toMatchObject({ notified: 0, skipped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markExpireNoticed).not.toHaveBeenCalled();
  });

  it('skips rotated generations (a newer token lives now)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([candidate(STEAM_A)]);
    // Re-issued since the scan: different expiry, still live.
    dal.getAccount.mockResolvedValue({
      ...unconfirmedAccount('2999-01-01T00:00:00.000Z'),
      confirmTokenHash: 'cd'.repeat(32),
    });

    const report = await pollConfirmExpiryOnce({ chat, ...rest });

    expect(report).toMatchObject({ notified: 0, skipped: 1 });
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
    expect(dal.markExpireNoticed).not.toHaveBeenCalled();
  });

  it('retries later when the send fails (never marks undelivered)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([candidate(STEAM_A)]);
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    chat.sendFriendMessage.mockRejectedValueOnce(new Error('chat down'));

    const report = await pollConfirmExpiryOnce({ chat, ...rest });

    expect(report).toMatchObject({ notified: 0 });
    expect(report.errors).toHaveLength(1);
    // Not marked: the next pass retries the same candidate.
    expect(dal.markExpireNoticed).not.toHaveBeenCalled();
  });

  it('counts a mark lost to a concurrent click as notified (info, not error)', async () => {
    // Click won the race between our recheck and the mark: the nag above
    // is stale but harmless, and the confirm route owns everything from
    // here. The user did exactly the right thing — never an error.
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([candidate(STEAM_A)]);
    dal.getAccount.mockResolvedValue(unconfirmedAccount());
    dal.markExpireNoticed.mockResolvedValue(false);

    const report = await pollConfirmExpiryOnce({
      chat,
      dal,
      logger,
      isFriend: () => true,
    });

    expect(report).toMatchObject({ notified: 1 });
    expect(report.errors).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(String(logger.info.mock.calls[0][0])).toContain('raced by a click');
  });

  it('isolates per-row failures (one bad row never aborts the pass)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);
    dal.listExpiredUnnoticedConfirms.mockResolvedValue([
      candidate(STEAM_A),
      candidate(STEAM_B),
    ]);
    dal.getAccount
      .mockRejectedValueOnce(new Error('turso blip'))
      .mockResolvedValueOnce(unconfirmedAccount());

    const report = await pollConfirmExpiryOnce({ chat, ...rest });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ steamId: STEAM_A });
    expect(report.notified).toBe(1);
    expect(chat.sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendFriendMessage).toHaveBeenCalledWith(
      STEAM_B,
      expect.any(String),
    );
  });

  it('skips the whole pass when disconnected (no DAL/chat touched)', async () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);

    const report = await pollConfirmExpiryOnce({
      chat,
      ...rest,
      isConnected: () => false,
    });

    expect(report.skippedPass).toBe(true);
    expect(dal.listExpiredUnnoticedConfirms).not.toHaveBeenCalled();
    expect(chat.sendFriendMessage).not.toHaveBeenCalled();
  });
});

describe('startConfirmExpiryPoller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws on invalid intervals (fail fast at wiring time)', () => {
    const dal = makeDal();
    const { chat, ...rest } = baseOptions(dal);

    expect(() =>
      startConfirmExpiryPoller({ chat, ...rest, pollIntervalMs: 0 }),
    ).toThrow(/interval/);
  });
});

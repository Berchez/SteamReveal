import { pollBanSweepOnce, startBanSweeper } from './banSweep';

const TARGET_A = '76561198000000001';
const TARGET_B = '76561198000000002';
const SUB_A = '76561198000000011';
const SUB_B = '76561198000000012';

const silentLogger = { info: jest.fn(), error: jest.fn() };

const makeDal = () => ({
  listDistinctBanTargets: jest.fn(async (): Promise<string[]> => []),
  getBanTarget: jest.fn(
    async (): Promise<{
      targetSteamId: string;
      lastKnownBanned: boolean;
      lastBanCheckedAt: string | null;
    } | null> => null,
  ),
  markBanTargetChecked: jest.fn(async (): Promise<void> => undefined),
  listUnnotifiedBanSubscriptions: jest.fn(
    async (): Promise<Array<{ id: number; subscriberSteamId: string }>> => [],
  ),
  enqueueBanAlertForSubscription: jest.fn(
    async (): Promise<{ enqueued: boolean; eventId: number | null }> => ({
      enqueued: true,
      eventId: 1,
    }),
  ),
});

describe('pollBanSweepOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks distinct targets in one batched call and fans out on false->true', async () => {
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A]);
    dal.getBanTarget.mockResolvedValue({
      targetSteamId: TARGET_A,
      lastKnownBanned: false,
      lastBanCheckedAt: '2026-01-01T00:00:00.000Z',
    });
    // Two subscribers on one target: one slot in the batch, two alerts.
    dal.listUnnotifiedBanSubscriptions.mockResolvedValue([
      { id: 1, subscriberSteamId: SUB_A },
      { id: 2, subscriberSteamId: SUB_B },
    ]);
    const steamCaller = jest.fn(async () => new Map([[TARGET_A, true]]));

    const report = await pollBanSweepOnce({
      dal,
      steamCaller,
      logger: silentLogger,
    });

    // One batched Steam call for the whole pass (never per-profile).
    expect(steamCaller).toHaveBeenCalledTimes(1);
    expect(steamCaller).toHaveBeenCalledWith([TARGET_A]);
    expect(report).toMatchObject({
      checked: 1,
      transitions: 1,
      alerted: 2,
      skipped: false,
    });
    expect(dal.markBanTargetChecked).toHaveBeenCalledWith(TARGET_A, true);
    expect(dal.enqueueBanAlertForSubscription).toHaveBeenCalledWith(1, SUB_A);
    expect(dal.enqueueBanAlertForSubscription).toHaveBeenCalledWith(2, SUB_B);
  });

  it('first-ever sighting of a banned target sets the baseline with NO alert', async () => {
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A]);
    dal.getBanTarget.mockResolvedValue(null);
    const logger = { info: jest.fn(), error: jest.fn() };
    const steamCaller = jest.fn(async () => new Map([[TARGET_A, true]]));

    const report = await pollBanSweepOnce({ dal, steamCaller, logger });

    expect(report).toMatchObject({ checked: 1, transitions: 0, alerted: 0 });
    expect(dal.markBanTargetChecked).toHaveBeenCalledWith(TARGET_A, true);
    // Nobody waiting: quiet info baseline, no error.
    expect(logger.info).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs LOUD when an ambiguous baseline skips subscribers (possible missed alert)', async () => {
    // The silent-miss hole: subscribe-time verification never succeeded
    // (checked_at NULL) and the first sweep sighting is already banned —
    // indistinguishable from a pre-existing ban, so nobody is alerted.
    // That must be visible in the error log, never silent.
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A]);
    dal.getBanTarget.mockResolvedValue(null);
    dal.listUnnotifiedBanSubscriptions.mockResolvedValue([
      { id: 1, subscriberSteamId: SUB_A },
      { id: 2, subscriberSteamId: SUB_B },
    ]);
    const logger = { info: jest.fn(), error: jest.fn() };
    const steamCaller = jest.fn(async () => new Map([[TARGET_A, true]]));

    const report = await pollBanSweepOnce({ dal, steamCaller, logger });

    expect(report).toMatchObject({ checked: 1, transitions: 0, alerted: 0 });
    expect(dal.enqueueBanAlertForSubscription).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('AMBIGUOUS');
    expect(String(logger.error.mock.calls[0][0])).toContain('2 subscriber(s)');
  });

  it('unban flips the flag only (never un-gates notified_at)', async () => {
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A]);
    dal.getBanTarget.mockResolvedValue({
      targetSteamId: TARGET_A,
      lastKnownBanned: true,
      lastBanCheckedAt: '2026-01-01T00:00:00.000Z',
    });
    const steamCaller = jest.fn(async () => new Map([[TARGET_A, false]]));

    const report = await pollBanSweepOnce({
      dal,
      steamCaller,
      logger: silentLogger,
    });

    expect(report).toMatchObject({ checked: 1, transitions: 0, alerted: 0 });
    expect(dal.markBanTargetChecked).toHaveBeenCalledWith(TARGET_A, false);
    expect(dal.listUnnotifiedBanSubscriptions).not.toHaveBeenCalled();
  });

  it('one bad target never blocks the rest of the batch', async () => {
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A, TARGET_B]);
    dal.getBanTarget.mockResolvedValue({
      targetSteamId: TARGET_A,
      lastKnownBanned: false,
      lastBanCheckedAt: '2026-01-01T00:00:00.000Z',
    });
    // Steam verdict missing for TARGET_B (malformed row): skipped silently.
    const steamCaller = jest.fn(async () => new Map([[TARGET_A, false]]));

    const report = await pollBanSweepOnce({
      dal,
      steamCaller,
      logger: silentLogger,
    });

    expect(report.checked).toBe(1);
    expect(dal.markBanTargetChecked).toHaveBeenCalledWith(TARGET_A, false);
    expect(dal.markBanTargetChecked).not.toHaveBeenCalledWith(
      TARGET_B,
      expect.anything(),
    );
  });

  it('Steam outage degrades to loud errors, never a throw', async () => {
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A]);
    const steamCaller = jest.fn(async () => {
      throw new Error('Steam down');
    });

    const report = await pollBanSweepOnce({
      dal,
      steamCaller,
      logger: silentLogger,
    });

    expect(report.checked).toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(dal.markBanTargetChecked).not.toHaveBeenCalled();
  });

  it('skips already-notified subscriptions (only ungated fan out)', async () => {
    const dal = makeDal();
    dal.listDistinctBanTargets.mockResolvedValue([TARGET_A]);
    dal.getBanTarget.mockResolvedValue({
      targetSteamId: TARGET_A,
      lastKnownBanned: false,
      lastBanCheckedAt: '2026-01-01T00:00:00.000Z',
    });
    // DAL already filters notified_at IS NULL: only the ungated sub arrives.
    dal.listUnnotifiedBanSubscriptions.mockResolvedValue([
      { id: 2, subscriberSteamId: SUB_B },
    ]);
    const steamCaller = jest.fn(async () => new Map([[TARGET_A, true]]));

    const report = await pollBanSweepOnce({
      dal,
      steamCaller,
      logger: silentLogger,
    });

    expect(report.alerted).toBe(1);
    expect(dal.enqueueBanAlertForSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('startBanSweeper', () => {
  it('rejects non-positive intervals and guards overlaps', async () => {
    const dal = makeDal();
    expect(() =>
      startBanSweeper({
        dal,
        steamCaller: async () => new Map(),
        sweepIntervalMs: 0,
      }),
    ).toThrow(/positive/);

    // Overlap: a hung listing makes the second pollOnce skip.
    dal.listDistinctBanTargets.mockImplementation(
      () => new Promise<string[]>(() => undefined),
    );
    const sweeper = startBanSweeper({
      dal,
      steamCaller: async () => new Map(),
      sweepIntervalMs: 60000,
      logger: silentLogger,
    });
    const first = sweeper.pollOnce();
    const second = await sweeper.pollOnce();
    expect(second.skipped).toBe(true);
    sweeper.stop();
    // Settle the hung pass without leaking (stop clears the timer; the
    // pending promise stays pending — do not await it).
    void first.catch(() => undefined);
  });
});

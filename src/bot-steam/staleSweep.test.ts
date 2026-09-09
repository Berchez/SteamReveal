import { sweepStaleClaimsOnce, startStaleClaimSweeper } from './staleSweep';

const silentLogger = { info: jest.fn(), error: jest.fn() };

const makeDal = () => ({
  resetStaleClaims: jest.fn(async () => 0),
});

describe('sweepStaleClaimsOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requeues orphans and logs only when something moved', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };
    dal.resetStaleClaims.mockResolvedValue(2);

    const requeued = await sweepStaleClaimsOnce({
      dal,
      logger,
      staleWindowMinutes: 30,
    });

    expect(requeued).toBe(2);
    expect(dal.resetStaleClaims).toHaveBeenCalledWith(30);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0][0])).toContain('2 orphaned');
  });

  it('stays quiet when nothing was orphaned', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };

    const requeued = await sweepStaleClaimsOnce({
      dal,
      logger,
      staleWindowMinutes: 30,
    });

    expect(requeued).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lets DAL failures propagate for the caller to handle', async () => {
    const dal = makeDal();
    dal.resetStaleClaims.mockRejectedValue(new Error('db down'));

    await expect(
      sweepStaleClaimsOnce({ dal, logger: silentLogger, staleWindowMinutes: 30 }),
    ).rejects.toThrow('db down');
  });
});

describe('startStaleClaimSweeper', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('sweeps on the interval until stopped, swallowing failures as logs', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };

    const handle = startStaleClaimSweeper({
      dal,
      logger,
      sweepIntervalMs: 600000,
      staleWindowMinutes: 30,
    });
    try {
      // No immediate sweep (index.ts fires the first one explicitly).
      expect(dal.resetStaleClaims).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(600000);
      expect(dal.resetStaleClaims).toHaveBeenCalledTimes(1);

      dal.resetStaleClaims.mockRejectedValueOnce(new Error('db down'));
      await jest.advanceTimersByTimeAsync(600000);
      expect(logger.error).toHaveBeenCalledTimes(1);

      handle.stop();
      await jest.advanceTimersByTimeAsync(3600000);
      expect(dal.resetStaleClaims).toHaveBeenCalledTimes(2);
    } finally {
      handle.stop();
    }
  });

  it('throws on invalid interval without scheduling anything', () => {
    const dal = makeDal();

    expect(() =>
      startStaleClaimSweeper({
        dal,
        sweepIntervalMs: 0,
        staleWindowMinutes: 30,
      }),
    ).toThrow(/interval/);
    expect(dal.resetStaleClaims).not.toHaveBeenCalled();
  });
});

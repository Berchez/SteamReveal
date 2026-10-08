import {
  MAX_HISTORY_PURGE_INTERVAL_MS,
  purgeHistoryOnce,
  startHistoryPurgePoller,
} from './historyPurge';
import { SEARCHER_LINK_TTL_MS } from '../lib/analytics/historyLimits';

const NOW = Date.parse('2026-10-06T00:00:00.000Z');

describe('purgeHistoryOnce (search-history retention)', () => {
  it('de-attributes rows older than the 12-month TTL with a stable cutoff', async () => {
    const purgeExpiredSearcherLinks = jest.fn(async () => 7);

    const report = await purgeHistoryOnce({
      dal: { purgeExpiredSearcherLinks },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      nowMs: NOW,
    });

    const expectedCutoff = new Date(NOW - SEARCHER_LINK_TTL_MS).toISOString();
    expect(purgeExpiredSearcherLinks).toHaveBeenCalledTimes(1);
    expect(purgeExpiredSearcherLinks).toHaveBeenCalledWith(expectedCutoff);
    expect(report).toEqual({
      purged: 7,
      cutoffIso: expectedCutoff,
      durationMs: expect.any(Number),
      skippedPass: false,
    });
  });

  it('reports zero (still healthy) when nothing expired', async () => {
    const info = jest.fn();
    const report = await purgeHistoryOnce({
      dal: { purgeExpiredSearcherLinks: async () => 0 },
      logger: { info, warn: jest.fn(), error: jest.fn() },
      nowMs: NOW,
    });

    expect(report.purged).toBe(0);
    expect(report.skippedPass).toBe(false);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('de-attributed=0'),
    );
  });

  it('lets DAL failures reject (index.ts trackPoll logs them)', async () => {
    await expect(
      purgeHistoryOnce({
        dal: {
          purgeExpiredSearcherLinks: async () => {
            throw new Error('turso down');
          },
        },
        nowMs: NOW,
      }),
    ).rejects.toThrow('turso down');
  });
});

describe('startHistoryPurgePoller (interval driver)', () => {
  it('rejects a non-positive interval at construction', () => {
    expect(() =>
      startHistoryPurgePoller({
        dal: { purgeExpiredSearcherLinks: async () => 0 },
        pollIntervalMs: 0,
      }),
    ).toThrow(/positive milliseconds/);
  });

  it('caps absurd intervals below the Node setInterval overflow (2^31-1)', async () => {
    // Past ~24.8d Node clamps to ~1ms (hot-loop). A "monthly" override
    // must degrade to the max timer, never to a busy loop.
    expect(MAX_HISTORY_PURGE_INTERVAL_MS).toBe(2 ** 31 - 1);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const handle = startHistoryPurgePoller({
      dal: { purgeExpiredSearcherLinks: async () => 0 },
      pollIntervalMs: 2_600_000_000,
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      MAX_HISTORY_PURGE_INTERVAL_MS,
    );
    setIntervalSpy.mockRestore();
    handle.stop();
  });

  it('skips overlapping passes (single UPDATE, never concurrent)', async () => {    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const purgeExpiredSearcherLinks = jest.fn(async () => {
      await gate;
      return 1;
    });
    const handle = startHistoryPurgePoller({
      dal: { purgeExpiredSearcherLinks },
      pollIntervalMs: 60_000,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const first = handle.pollOnce();
    const skipped = await handle.pollOnce();
    expect(skipped.skippedPass).toBe(true);
    release();
    const done = await first;
    expect(done.purged).toBe(1);
    expect(purgeExpiredSearcherLinks).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  startHeartbeat,
  evaluateHeartbeat,
  HEARTBEAT_PAYLOAD_KEYS,
} from './heartbeat';

describe('heartbeat writer', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchbot-heartbeat-'));
    filePath = path.join(dir, 'heartbeat.json');
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes exactly the documented key set (structural secret-leak guard)', () => {
    const handle = startHeartbeat({
      filePath,
      intervalMs: 1000,
      getStatus: () => ({ connected: true, steamId: '76561198000000001' }),
      startedAt: 1000000,
      now: () => 1000000 + 65000,
      pid: 1234,
    });
    try {
      handle.beat();

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parsed).sort()).toEqual(
        [...HEARTBEAT_PAYLOAD_KEYS].sort(),
      );
      expect(parsed).toEqual({
        timestamp: new Date(1065000).toISOString(),
        pid: 1234,
        uptimeSec: 65,
        connected: true,
        steamId: '76561198000000001',
      });
    } finally {
      handle.stop();
    }
  });

  it('ticks on the interval and stops ticking after stop()', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    const handle = startHeartbeat({
      filePath,
      intervalMs: 1000,
      getStatus: () => ({ connected: false, steamId: null }),
    });

    expect(writeSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2500);
    const writesWhileRunning = writeSpy.mock.calls.length;
    expect(writesWhileRunning).toBeGreaterThanOrEqual(2);

    handle.stop();
    jest.advanceTimersByTime(60000);
    expect(writeSpy.mock.calls.length).toBe(writesWhileRunning);
  });

  it('a failing write never throws out of the interval tick', () => {
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    const handle = startHeartbeat({
      filePath,
      intervalMs: 1000,
      getStatus: () => ({ connected: true, steamId: null }),
    });
    try {
      expect(() => jest.advanceTimersByTime(3000)).not.toThrow();
    } finally {
      handle.stop();
    }
  });
});

describe('evaluateHeartbeat', () => {
  const STALE_MS = 180000;
  const NOW = 2000000000000;

  const fresh = (timestamp: string) => JSON.stringify({ timestamp });

  it('is healthy for a fresh heartbeat', () => {
    const verdict = evaluateHeartbeat(
      fresh(new Date(NOW - 5000).toISOString()),
      STALE_MS,
      NOW,
    );
    expect(verdict).toEqual({ healthy: true, ageMs: 5000 });
  });

  it.each([
    ['missing file', null],
    ['corrupt JSON', '{nope'],
    ['missing timestamp', JSON.stringify({ pid: 1 })],
    ['unparseable timestamp', fresh('not-a-date')],
    ['future timestamp', fresh(new Date(NOW + 60000).toISOString())],
    [
      'stale heartbeat',
      fresh(new Date(NOW - STALE_MS - 1000).toISOString()),
    ],
  ])('is unhealthy: %s', (_label, raw) => {
    const verdict = evaluateHeartbeat(raw, STALE_MS, NOW);
    expect(verdict.healthy).toBe(false);
    if (!verdict.healthy) {
      expect(typeof verdict.reason).toBe('string');
    }
  });

  it('treats the exact threshold boundary as healthy', () => {
    const verdict = evaluateHeartbeat(
      fresh(new Date(NOW - STALE_MS).toISOString()),
      STALE_MS,
      NOW,
    );
    expect(verdict.healthy).toBe(true);
  });
});

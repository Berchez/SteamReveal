/**
 * @jest-environment node
 */

// fs/process integration, see opsLog.test.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';

import logRouteError from './logRouteError';

describe('logRouteError ops-log wiring', () => {
  let dir: string;
  let savedDir: string | undefined;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    savedDir = process.env.OPS_LOG_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opslog-route-'));
    process.env.OPS_LOG_DIR = dir;
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.OPS_LOG_DIR;
    else process.env.OPS_LOG_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('keeps the console call byte-identical and mirrors a sanitized line with stack to disk', () => {
    const error = new Error('query failed authToken=topsecret');
    error.stack =
      'Error: query failed authToken=topsecret\n    at handler (route.ts:10:5)';
    logRouteError('watchStatus', error, { steamId: '765' });

    // Console: exact legacy shape (message + the full error object).
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [logged, raw] = consoleSpy.mock.calls[0];
    expect(logged).toContain('watchStatus - Internal server error:');
    expect(raw).toBe(error);

    // Disk: route-prefixed, sanitized, stack attached, context flattened.
    const dayFile = fs.readdirSync(dir).find((f) => f.startsWith('site-'));
    expect(dayFile).toBeDefined();
    const content = fs.readFileSync(path.join(dir, dayFile as string), 'utf8');
    expect(content).toContain(
      'watchStatus: query failed authToken=[REDACTED]',
    );
    expect(content).not.toContain('topsecret');
    expect(content).toContain('stack=');
    expect(content).toContain('route.ts:10:5');
    expect(content).toContain('steamId=765');
  });

  it('omits the stack key for non-Error values', () => {
    logRouteError('misc', 'plain string failure');
    const dayFile = fs.readdirSync(dir).find((f) => f.startsWith('site-'));
    const content = fs.readFileSync(path.join(dir, dayFile as string), 'utf8');
    expect(content).toContain('plain string failure');
    expect(content).not.toContain('stack=');
  });
});

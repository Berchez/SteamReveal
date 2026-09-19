/**
 * @jest-environment node
 */

// Spawns the viewer as a child process.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.join(__dirname, 'tail-errors.cjs');

interface TailResult {
  stdout: string;
  status: number;
}

/**
 * Runs the plain-node viewer in a child process with a fixture log dir.
 * execFileSync throws on non-zero exit — normalize to { stdout, status }
 * so exit codes are assertable. OPS_LOG_DIR is always overridden per test
 * (the ambient jest.setup.js value must never leak in).
 */
const runTail = (
  args: string[] = [],
  logDir: string,
): TailResult => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, OPS_LOG_DIR: logDir },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: unknown; status?: unknown };
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
};

describe('tail-errors.cjs', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-errors-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing log directory distinctly (exit 0)', () => {
    const missing = path.join(dir, 'never-created');
    const { stdout, status } = runTail([], missing);
    expect(status).toBe(0);
    expect(stdout).toContain('Log directory not found');
    expect(stdout).toContain('OPS_LOG_DIR');
  });

  it('reports an existing dir without errors.log as clean (exit 0)', () => {
    const { stdout, status } = runTail([], dir);
    expect(status).toBe(0);
    expect(stdout).toContain('No errors logged yet');
  });

  it('prints the last N lines, newest last', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `[t] [bot] ERROR: event ${i + 1}`,
    );
    fs.writeFileSync(path.join(dir, 'errors.log'), `${lines.join('\n')}\n`);
    const { stdout, status } = runTail(['--lines=2'], dir);
    expect(status).toBe(0);
    expect(stdout).toBe('[t] [bot] ERROR: event 4\n[t] [bot] ERROR: event 5\n');
  });

  it('defaults to 50 lines', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `event ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'errors.log'), `${lines.join('\n')}\n`);
    const { stdout, status } = runTail([], dir);
    expect(status).toBe(0);
    const printed = stdout.trim().split('\n');
    expect(printed).toHaveLength(50);
    expect(printed[0]).toBe('event 11');
  });

  it('rejects unknown arguments (exit 2) but ignores a lone separator', () => {
    fs.writeFileSync(path.join(dir, 'errors.log'), 'only\n');
    expect(runTail(['--bogus'], dir).status).toBe(2);
    const ok = runTail(['--', '--lines=1'], dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('only\n');
  });
});

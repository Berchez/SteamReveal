#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Pre-push hygiene: free the ports the push gates need before they run.
 *
 * The e2e suite AND the LHCI gate each boot their own `next dev -p 3100`
 * with `reuseExistingServer: false`, so ANY leftover listener on :3100
 * (typically an orphaned dev server from a previously aborted Ctrl+C'd
 * push — Playwright only cleans up on normal completion) fails the whole
 * push with "port already used". :3101 (proxy/tunnel-manual reservation)
 * is covered for the same reason.
 *
 * SAFETY FIRST: this script only kills processes it can positively
 * identify as Next.js dev servers of THIS repo (command line contains a
 * next dev-server marker AND the repo directory name). Anything else
 * listening (your tunnel, cloudflared, a database, another project) is
 * reported and left alone — if such a process holds a needed port, the
 * script exits 1 with an actionable message instead of killing blindly.
 *
 * Cross-platform: netstat + powershell/cmdline lookup on Windows,
 * lsof + ps elsewhere. If the listing tool is missing, it warns loudly
 * and exits 0 (a truly busy port still fails later with the gate's own
 * clear error — never block a push on this script's tooling gaps).
 *
 * Usage: node scripts/prepush-clean.cjs (first step of .husky/pre-push).
 */

const { execFileSync, spawnSync } = require('node:child_process');

const PORTS = [3100, 3101];
const SETTLE_WAIT_MS = 5000;
const SETTLE_POLL_MS = 500;

const isWindows = process.platform === 'win32';

/**
 * Parse `netstat -ano` output, returning PIDs in LISTENING state on the
 * given port. Pure (unit-tested).
 */
const parseWindowsListeningPids = (output, port) => {
  const suffix = `:${port}`;
  const pids = new Set();
  for (const line of String(output).split('\n')) {
    const parts = line.trim().split(/\s+/);
    // TCP    <local>    <remote>    LISTENING    <pid>
    if (parts.length < 4) continue;
    const [proto, local, , state, pid] = parts;
    if (!/^TCP/i.test(proto)) continue;
    if (state !== 'LISTENING') continue;
    // Local address forms: 0.0.0.0:3100 or [::]:3100 — compare the port
    // after the last colon AND require the :port suffix (avoids 31001).
    const hostPort = local.slice(local.lastIndexOf(':') + 1);
    if (hostPort !== String(port) || !local.endsWith(suffix)) continue;
    const n = Number(pid);
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
};

/**
 * Parse `lsof -iTCP:<port> -sTCP:LISTEN -Pn` output, returning PIDs.
 * Pure (unit-tested).
 */
const parseLsofListeningPids = (output) => {
  const pids = new Set();
  for (const line of String(output).split('\n')) {
    // node   1234   user ...  TCP *:3100 (LISTEN)
    if (!line.includes('(LISTEN)')) continue;
    const parts = line.trim().split(/\s+/);
    const n = Number(parts[1]);
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
};

/**
 * True only for a Next.js dev server command line of THIS repo. Deliberately
 * narrow: ts-node scripts (bot, proxy, smokes), jest workers, editors and
 * any other project's servers must never match. Pure (unit-tested).
 */
const isRepoDevServer = (commandLine) => {
  const cmd = String(commandLine || '');
  if (/bot-steam|proxy-local|ts-node|jest|vitest/i.test(cmd)) return false;
  const isNextDev =
    /start-server\.js/i.test(cmd) ||
    /next([\\/]dist[\\/]bin[\\/]next)?\s+dev/i.test(cmd);
  if (!isNextDev) return false;
  return /osint-steam/i.test(cmd);
};

const runQuiet = (file, args) => {
  try {
    return {
      ok: true,
      out: execFileSync(file, args, { encoding: 'utf8', timeout: 15000 }),
    };
  } catch (error) {
    return { ok: false, out: '', error };
  }
};

const listeningPids = (port) => {
  if (isWindows) {
    const net = runQuiet('netstat', ['-ano']);
    if (!net.ok) {
      console.warn(
        `[prepush-clean] netstat unavailable, skipping port ${port}`,
      );
      return null;
    }
    return parseWindowsListeningPids(net.out, port);
  }
  const lsof = runQuiet('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-Pn']);
  if (!lsof.ok) {
    console.warn(`[prepush-clean] lsof unavailable, skipping port ${port}`);
    return null;
  }
  return parseLsofListeningPids(lsof.out);
};

const commandLineOf = (pid) => {
  if (isWindows) {
    const ps = runQuiet('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
    ]);
    return ps.ok ? ps.out.trim() : '';
  }
  const out = runQuiet('ps', ['-o', 'command=', '-p', String(pid)]);
  return out.ok ? out.out.trim() : '';
};

const killPid = (pid) => {
  if (isWindows) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
    });
    return r.status === 0;
  }
  const term = spawnSync('kill', [String(pid)]);
  if (term.status !== 0) return false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (commandLineOf(pid) === '') return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  const kill = spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
  return kill.status === 0;
};

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const main = () => {
  let failed = false;
  for (const port of PORTS) {
    const pids = listeningPids(port);
    if (pids === null) continue;
    if (pids.length === 0) {
      console.log(`[prepush-clean] :${port} free`);
      continue;
    }
    for (const pid of pids) {
      const cmd = commandLineOf(pid);
      if (isRepoDevServer(cmd)) {
        console.log(
          `[prepush-clean] killing orphaned repo dev server (pid ${pid}) on :${port}`,
        );
        if (!killPid(pid)) {
          console.error(
            `[prepush-clean] could not kill pid ${pid} — free :${port} manually`,
          );
          failed = true;
        }
      } else {
        console.error(
          `[prepush-clean] :${port} is held by pid ${pid} (${cmd.slice(0, 120) || 'unknown command'}) — ` +
            'not a repo dev server, leaving it alone. Free the port manually and push again.',
        );
        failed = true;
      }
    }
    // Confirm the port actually drained before the gates boot their own servers.
    const deadline = Date.now() + SETTLE_WAIT_MS;
    let drained = false;
    while (Date.now() < deadline) {
      const rest = listeningPids(port);
      if (rest !== null && rest.length === 0) {
        drained = true;
        break;
      }
      sleepSync(SETTLE_POLL_MS);
    }
    if (!drained) {
      console.error(
        `[prepush-clean] :${port} still busy after cleanup — free it manually and push again.`,
      );
      failed = true;
    } else {
      console.log(`[prepush-clean] :${port} free`);
    }
  }
  if (failed) process.exit(1);
};

if (require.main === module) {
  main();
}

module.exports = {
  parseWindowsListeningPids,
  parseLsofListeningPids,
  isRepoDevServer,
};

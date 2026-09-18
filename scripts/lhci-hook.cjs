// pre-push Lighthouse regression gate.
//
// Wired into .husky/pre-push. Resolves a Chrome/Chromium binary (LHCI needs
// one to run the audit), then runs the full `lhci autorun` gate from
// lighthouserc.js against the local mocked dev server. This push is BLOCKED
// (non-zero exit — the hook runs under `set -e`) when:
//   - no Chrome binary can be found (actionable message below), or
//   - LHCI itself reports an assertion failure / regression (it exits non-zero).
// There is deliberately NO skip switch and no skip-on-missing-Chrome: the
// gate is the point. `git push --no-verify` is the only escape hatch.
//
// Chrome resolution order:
//   1. $CHROME_PATH (explicit)
//   2. puppeteer browser cache (where `.github/workflows/lighthouse.yml`
//      installs a pinned Chrome via `npx @puppeteer/browsers install`)
//   3. well-known per-OS install paths
// chrome-launcher is NOT required here on purpose (strict pnpm doesn't hoist
// transitive deps, so it isn't bare-resolvable).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const platform = process.platform;

function collectPuppeteerChromeCandidates() {
  const candidates = [];
  const cacheRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(os.homedir(), '.cache', 'puppeteer'),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'puppeteer')
      : path.join(os.homedir(), 'AppData', 'Local', 'puppeteer'),
  ].filter(Boolean);

  for (const root of cacheRoots) {
    const browserDir = path.join(root, 'chrome');
    let subdirs = [];
    try {
      subdirs = fs.readdirSync(browserDir);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const subPath = path.join(browserDir, sub);
      // @puppeteer/browsers installs e.g. chrome-win64/chrome.exe,
      // chrome-linux64/chrome, chrome-mac*/.../Google Chrome
      candidates.push(path.join(subPath, 'chrome-linux64', 'chrome'));
      candidates.push(path.join(subPath, 'chrome-win64', 'chrome.exe'));
      candidates.push(
        path.join(
          subPath,
          'chrome-mac-arm64',
          'Google Chrome.app',
          'Contents',
          'MacOS',
          'Google Chrome',
        ),
      );
      candidates.push(
        path.join(
          subPath,
          'chrome-mac-x64',
          'Google Chrome.app',
          'Contents',
          'MacOS',
          'Google Chrome',
        ),
      );
    }
  }
  return candidates;
}

function wellKnownCandidates() {
  const home = os.homedir();
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(
        process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    ...collectPuppeteerChromeCandidates(),
    ...wellKnownCandidates(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // invalid path — skip
    }
  }
  return undefined;
}

const chromePath = resolveChrome();

if (!chromePath) {
  console.error(
    [
      '',
      '[lhci-hook] No Chrome/Chromium binary found.',
      '[lhci-hook] The Lighthouse regression gate (lighthouserc.js) needs a Chrome binary to audit,',
      '[lhci-hook] so this push is BLOCKED — the gate would otherwise silently not run.',
      '',
      '  Fix one of:',
      `    - Install Google Chrome/Chromium (${platform === 'win32' ? 'default install is auto-found' : 'default paths are auto-found'}), or`,
      '    - Export CHROME_PATH pointing at the Chrome binary and push again.',
      '      (Windows e.g.: set CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")',
      '      (macOS e.g.:  export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")',
      '      (Linux e.g.:  export CHROME_PATH="$(which google-chrome-stable)")',
      '',
      '  Only bypass with: git push --no-verify',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.env.CHROME_PATH = chromePath;
console.log(`[lhci-hook] Chrome: ${chromePath}`);
console.log('[lhci-hook] Running Lighthouse CI regression gate (lhci autorun)...');

// Hard ceiling: `lhci autorun` boots a dev server and runs 3x2 audits —
// normally minutes, but a wedged server/Chrome made `git push` hang FOREVER
// with zero output (the exact "pre-push hangs forever" report). On expiry
// the child is killed and the push FAILS LOUDLY (exit 1) instead of hanging.
// Override for very slow machines: LHCI_HOOK_TIMEOUT_MS=<ms>.
const LHCI_TIMEOUT_MS = (() => {
  const raw = Number(process.env.LHCI_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15 * 60 * 1000;
})();
console.log(`[lhci-hook] Timeout budget: ${Math.round(LHCI_TIMEOUT_MS / 60000)} min`);

const child = spawn('pnpm', ['run', 'lhci'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: platform === 'win32',
});

let settled = false;
let timedOut = false;

const killChild = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // already dead — the exit handler below settles the run
  }
};

const lhciTimer = setTimeout(() => {
  timedOut = true;
  console.error(
    [
      '',
      `[lhci-hook] TIMEOUT after ${Math.round(LHCI_TIMEOUT_MS / 60000)} min — killing the LHCI run, push blocked.`,
      '[lhci-hook] The audit stalled (wedged dev server or Chrome). Re-run `pnpm run lhci` manually to see where it sticks.',
      '[lhci-hook] Slow machine that legitimately needs longer? LHCI_HOOK_TIMEOUT_MS=<ms> git push',
      '',
      'Only bypass with: git push --no-verify',
      '',
    ].join('\n'),
  );
  killChild('SIGTERM');
  // SIGTERM can be swallowed (Windows cmd wrapper, stuck Chrome): escalate.
  setTimeout(() => {
    if (!settled) killChild('SIGKILL');
  }, 10000).unref?.();
}, LHCI_TIMEOUT_MS);
if (lhciTimer.unref) lhciTimer.unref();

// Ctrl+C MUST reach the audit: without forwarding, killing this wrapper
// orphaned `pnpm run lhci` + its Next dev server on :3100, and the NEXT push
// then failed/hung on the busy port. Forward, and only force-exit if the
// child ignores the signal (second Ctrl+C exits immediately).
let sigintCount = 0;
const forwardSignal = (signal) => {
  sigintCount += 1;
  if (sigintCount > 1) process.exit(130);
  console.log(`[lhci-hook] Got ${signal} — forwarding to the LHCI run...`);
  killChild(signal);
  setTimeout(() => {
    if (!settled) process.exit(130);
  }, 5000).unref?.();
};
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('error', (err) => {
  clearTimeout(lhciTimer);
  settled = true;
  console.error('[lhci-hook] Failed to start pnpm:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(lhciTimer);
  settled = true;
  if (timedOut) process.exit(1);
  if (code !== 0) {
    console.error(
      [
        '',
        `[lhci-hook] Lighthouse gate FAILED (exit ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}) — push blocked.`,
        '[lhci-hook] A regression/assertion failure is reported above by LHCI itself.',
        '',
        'Only bypass with: git push --no-verify',
        '',
      ].join('\n'),
    );
  }
  process.exit(code === null ? 1 : code);
});
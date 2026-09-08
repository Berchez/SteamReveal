// Cross-platform webserver launcher for Lighthouse CI.
//
// LHCI 0.15.x spawns the collect-server command through a shell WITHOUT the
// ability to inject env vars from lighthouserc.js (the `webserver.env` key is
// not supported — only `startServerCommand` is honored). Inline env prefixes
// (`FOO=1 cmd`) also don't work on Windows `cmd.exe`. Setting the mock-mode
// vars here and then exec'ing the real Next.js binary keeps the audit hermetic
// and the file portable across Windows / Linux runners.
process.env.DEV_TEST_MODE = '1';
process.env.PORT = '3100';
process.env.LOCAL_PROXY_URL = '';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const nextBin = require.resolve('next/dist/bin/next');

// A cold dev-server run pays a big first-hit cost: Next compiles the page
// route AND every /api route the page calls during that very page load, all
// under Lighthouse's 4x-CPU / Slow-4G throttle. That made run #1 of each URL
// spike (e.g. player CLS 0.61) while runs 2/3 measured ~0.14 — pure dev-compile
// noise that never exists in a production build. We warm everything before
// exposing the server to LHCI: fetch each audited page (compiles the route +
// its client chunks) and each read-only /api route (compiles the route handler,
// validation 400s are fine — compilation is what we pay for). The "Ready in"
// line is only emitted AFTER warm-up, so `startServerReadyPattern` never starts
// the audit against a cold server.
const WARM_TARGETS = [
  'http://localhost:3100/en',
  'http://localhost:3100/en/player/player-with-friends',
  // read-only API routes used by the player flow (in mock mode these return
  // fixtures or a benign 400 for the empty params — both compile the handler)
  'http://localhost:3100/api/getSteamId',
  'http://localhost:3100/api/getUserInfo',
  'http://localhost:3100/api/getCloseFriends',
  'http://localhost:3100/api/getCheaterProbability',
  'http://localhost:3100/api/getFaceitLink',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function warmUp() {
  for (const url of WARM_TARGETS) {
    try {
      await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      // The route may still have responded mid-compile or the error is the
      // deliberate 400/405 of a no-params warm call — compilation happened
      // regardless. Never let a warm-up failure abort the audit.
      process.stdout.write(`[warmup] ignore ${url}: ${err.message}\n`);
    }
  }
  // Let compiled chunks / lazy modules settle before the first audit starts.
  await sleep(2000);
}

const child = spawn(process.execPath, [nextBin, 'dev', '-p', process.env.PORT], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: process.env,
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));

(async () => {
  if (!child.stdout) {
    process.stderr.write('[warmup] no stdout — cannot wait for ready\n');
    process.stdout.write('Ready in 0ms\n');
    return;
  }

  const rl = readline.createInterface({ input: child.stdout });
  let startedWarmup = false;
  let emitted = false;
  const hold = [];
  rl.on('line', (line) => {
    if (emitted) {
      process.stdout.write(`${line}\n`);
      return;
    }
    if (!startedWarmup && /Ready in/.test(line)) {
      startedWarmup = true;
      // Defer the ready signal: warm everything up, THEN emit the buffered
      // Next logs and our own "Ready in" so LHCI's startServerReadyPattern
      // never kicks off the audit against a cold (still-compiling) server.
      (async () => {
        try {
          await warmUp();
        } catch (err) {
          process.stderr.write(`[warmup] ${err.message}\n`);
        }
        for (const held of hold) {
          process.stdout.write(`${held}\n`);
        }
        hold.length = 0;
        emitted = true;
        process.stdout.write('Ready in 0ms\n');
      })();
      return;
    }
    hold.push(line);
  });
})();
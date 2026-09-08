// Lighthouse CI config for SteamReveal.
//
// Runs Lighthouse against a LOCAL mocked dev server (DEV_TEST_MODE=1 on
// port 3100) — the same harness the Playwright e2e suite uses — so the
// audit never touches production, real user data, or the real Steam/GC/FACEIT
// network. This keeps the run hermetic and deterministic.
//
// Asserts are deliberately conservative: they exist to block metric
// REGRESSIONS (the CLS guard is set above the whole observed toolchain band
// — 0.13 to 0.23 depending on the auditing Chrome build — so it clears the
// normal range but fails loudly if we ever push above it), not to demand a
// perfect score. Tune the numbers to your real targets once you have a
// stable trend.
module.exports = {
  ci: {
    collect: {
      // Start the mocked dev server (Next on 3100, DEV_TEST_MODE=1) to audit.
      // NOTE: LHCI 0.15.x does NOT support the `webserver` config key or an
      // `env` map for the spawned command. We therefore use a wrapper script
      // (scripts/lhci-webserver.cjs) that sets the mock env and execs Next —
      // cross-platform and shell-independent (inline `FOO=1 ...` prefixes
      // don't work on Windows cmd).
      startServerCommand: 'node scripts/lhci-webserver.cjs',
      startServerReadyPattern: 'Ready in',
      startServerReadyTimeout: 120000,
      url: [
        'http://localhost:3100/en',
        'http://localhost:3100/en/player/player-with-friends',
      ],
      // Multiple runs; LHCI reports the median, smoothing one-off flake.
      numberOfRuns: 3,
      // Match the mobile + Slow 4G scenario of the production Lighthouse
      // report (Lighthouse 13, Moto G Power class viewport). throttleMethod
      // 'simulate' uses the standard mobile Slow 4G network/throttling model.
      settings: {
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 2.625,
        },
        throttlingMethod: 'simulate',
        // Disable the noisy, non-CTX third-party requests (ads, telemetry)
        // so the audit focuses on first-party layout/performance.
        onlyCategories: ['performance'],
      },
    },
    assert: {
      assertions: {
        // CLS is the ONLY hard gate, and the reason this harness exists: it is
        // a layout property, so it is just as meaningful in dev mode as in
        // prod and is the regression the earlier CLS investigation targeted.
        // Threshold 0.30 sits ABOVE the whole observed toolchain band: the
        // representative (median-of-3) player value for the SAME code ranges
        // ~0.13 (retail Chrome 152) to ~0.23 (Chrome-for-Testing 137/138, the
        // builds both the puppeteer cache and the CI install step use) — the
        // auditing browser changes the measured CLS by ~2x. 0.30 clears the
        // worst representative with margin but fails loudly on a real layout
        // regression (the empty-frame→skeleton→data collapse pushes the
        // representative to ~0.6+). NOTE the player page CLS is volatile
        // (skeleton swap can spike a single run above the gate); LHCI asserts
        // on the representative run, so an isolated spike won't fail — a
        // consistent regression will.
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.3 }],

        // Everything below is dev-mode indicative only. LCP/TBT/SI in dev
        // (uncompressed assets + simulated mobile throttling) are wildly off
        // from production numbers, so these are set to the measured dev upper
        // bounds: they catch catastrophic regressions but never gate normally.
        // Real-world perf targets are covered by Vercel Speed Insights / CrUX.
        'categories:performance': ['warn', { minScore: 0.3 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 22000 }],
        'total-blocking-time': ['warn', { maxNumericValue: 2600 }],
        'speed-index': ['warn', { maxNumericValue: 20000 }],
      },
    },
    upload: {
      // No external storage/server. Nothing is pushed anywhere — results stay
      // local (target dir) so a run never leaks to a remote service.
      target: 'filesystem',
      outputDir: '.lighthouseci',
      reportFilenamePattern: 'lighthouse-%%HASH%%-%%timestamp%%.report.html',
    },
  },
};

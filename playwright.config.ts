import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// Hermetic ops-log dir for the e2e dev server: fixed path, wiped at every
// config load (no litter growth), so error-path tests that execute real
// routes never touch the repo's .data/logs. Mirrors jest.setup.js. Fixed
// (not mkdtemp-unique) by design: port 3100 already serializes runs on one
// machine, so no two suites can collide on it — unlike Jest workers, which
// need per-file dirs.
const E2E_OPS_LOG_DIR = path.join(os.tmpdir(), 'opslog-e2e');
fs.rmSync(E2E_OPS_LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(E2E_OPS_LOG_DIR, { recursive: true });

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // The E2E server runs in Next development mode. Concurrent workers can
  // compete for on-demand compilation and make client-side navigation
  // assertions time out even though the app flow is correct.
  workers: 1,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  // The dev server compiles routes on demand, so the first test to hit a
  // given route can cold-compile it and blow a navigation assertion timeout
  // even though the flow is correct (see the `workers` comment above). One
  // retry absorbs that one-off warm-up flake — it only re-runs the failed
  // test, not the whole suite.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100/en',
    trace: 'retain-on-failure',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm run dev',
    port: 3100,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      DEV_TEST_MODE: '1',
      PORT: '3100',
      LOCAL_PROXY_URL: '',
      // Test-only session secret (mirrors the documented local-dev value
      // shape): lets the WB e2e suite seal real iron-session cookies via
      // the mock-gated /api/auth/test-login route. Never used outside
      // localhost e2e — production reads SESSION_SECRET from its own env.
      SESSION_SECRET: 'e2e-test-session-secret-32-chars-min!!',
      // Second test-login gate layer (mirrors E2E_TEST_SECRET_VALUE in
      // e2e/support/fixtures.ts): the ONLY server env that carries it.
      // Deliberately absent from .env.example — without it, the route 404s
      // even if the mock-mode env gate somehow passed on a real host.
      E2E_TEST_SECRET: 'e2e-only-test-login-secret',
      // Ops-log isolation (see E2E_OPS_LOG_DIR above): the error paths
      // exercised here run real route code.
      OPS_LOG_DIR: E2E_OPS_LOG_DIR,
    },
  },
});

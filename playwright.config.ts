import { defineConfig, devices } from '@playwright/test';

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
  retries: 0,
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
    },
  },
});

import { test as base, expect, Page } from '@playwright/test';
import { routeApiMocks } from './mocks';

// Every test in this suite starts by mocking the API — so bake it into the
// `page` fixture itself instead of repeating `await routeApiMocks(page)` as
// the first line of every test. Route overrides added inside a test body
// still win: Playwright matches the most-recently-registered handler for a
// given pattern first, and this fixture's routes are registered during
// setup, before the test body runs — so ordering (and behavior) is
// identical to the old "call it manually first" pattern.
export const test = base.extend({
  page: async ({ page }, use) => {
    await routeApiMocks(page);
    await use(page);
  },
});

export { expect };

/**
 * Test-only login secret, mirrored in playwright.config.ts webServer env
 * (E2E_TEST_SECRET) — the ONLY place the server reads it from. Deliberately
 * NOT in .env/.env.example: anywhere without that server env (i.e. every
 * real deploy) the test-login route 404s regardless of the header sent,
 * so this public-by-design value is useless outside localhost e2e.
 */
export const E2E_TEST_SECRET_VALUE = 'e2e-only-test-login-secret';

/**
 * Logs in through the TEST-ONLY seam (`POST /api/auth/test-login`,
 * mock-mode gated + test-secret gated server-side): the real Next server
 * seals a real iron-session cookie, so every later navigation exercises
 * the genuine session path — no localStorage identity anywhere in this
 * flow.
 *
 * `page.request` owns a SEPARATE cookie jar from the page itself, so the
 * Set-Cookie from the login response is forwarded into the browser
 * context explicitly (standard Playwright cookie-bridging pattern).
 */
export const loginTestUser = async (page: Page, steamId: string) => {
  const res = await page.request.post('/api/auth/test-login', {
    data: { steamId },
    headers: { 'x-e2e-test-secret': E2E_TEST_SECRET_VALUE },
  });
  if (!res.ok()) {
    throw new Error(`test-login failed: HTTP ${res.status()}`);
  }
  const setCookie = res.headers()['set-cookie'];
  if (!setCookie) {
    throw new Error('test-login answered without a session cookie');
  }
  const [pair] = setCookie.split(';');
  const separator = pair.indexOf('=');
  // Host from the login response URL, not a hardcoded 'localhost': the
  // cookie must belong to wherever the suite actually runs (baseURL).
  const hostname = new URL(res.url()).hostname;
  await page.context().addCookies([
    {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: hostname,
      path: '/',
    },
  ]);
};

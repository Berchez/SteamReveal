import { test as base, expect, Page } from '@playwright/test';
import { WATCH_IDENTITY_KEY } from '@/app/templates/Home/hooks/watch/watchIdentity';
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
 * Seeds the watch identity (`steamreveal:watch:me`) BEFORE the app's JS
 * runs. Single source for the storage key: it is imported from the app
 * module (not a raw string), so a key change breaks loudly here instead
 * of silently seeding a slot the app never reads. Same single-goto
 * caveat as seedShowThresholds in mocks.ts: only use before the first
 * navigation of a test.
 */
export const seedWatchIdentity = async (page: Page, steamId: string) => {
  await page.addInitScript(
    ({ key, id }: { key: string; id: string }) => {
      window.localStorage.setItem(key, id);
    },
    { key: WATCH_IDENTITY_KEY, id: steamId },
  );
};

/**
 * Fills the watch-page SteamID field and submits. The field has no
 * test-id; the translated placeholder is the most specific stable
 * selector (a bare textbox role would go ambiguous the day a second
 * input appears on the page).
 */
export const submitWatchRequest = async (page: Page, steamId: string) => {
  await page.getByPlaceholder('SteamID64 (17 digits)').fill(steamId);
  await page.getByRole('button', { name: 'Watch this profile' }).click();
};

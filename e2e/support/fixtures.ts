import { test as base, expect } from '@playwright/test';
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

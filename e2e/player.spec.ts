import { test, expect, Page } from '@playwright/test';
import {
  isMockInvalidTarget,
  makeMockCloseFriends,
  makeMockProfile,
} from '@/mocks/devFixtures';

const expectNoLocationSkeletons = async (page: Page) => {
  await expect(page.locator('[data-testid="location-skeleton-provided"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="location-skeleton-map"]')).toHaveCount(0);
};

async function routeApiMocks(page: Page) {
  await page.route('**/api/getUserInfo', async (route) => {
    const req = route.request();
    const post = await req.postData();
    let body = {} as any;
    try {
      body = post ? JSON.parse(post) : {};
    } catch {
      // ignore invalid JSON
    }

    const target = body.target as string | undefined;

    if (!target) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'missing target' }),
      });
    }

    if (isMockInvalidTarget(target)) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid target.' }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ targetInfo: makeMockProfile(target) }),
    });
  });

  await page.route('**/api/getCloseFriends', async (route) => {
    const req = route.request();
    const post = await req.postData();
    const body = post ? JSON.parse(post) : {};
    const target = body.target as string | undefined;

    if (!target || isMockInvalidTarget(target)) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid target.' }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ closeFriends: makeMockCloseFriends(target) }),
    });
  });

  await page.route('**/api/getSteamId', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const target = url.searchParams.get('target');

    if (!target) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'missing target' }),
      });
    }

    if (isMockInvalidTarget(target)) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid target.' }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ steamId: target }),
    });
  });

  await page.route('**/api/recordAnalytics', async (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/feedback', async (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

test.describe('Player page - visual smoke tests', () => {
  test('Home welcome section remains visible and the feedback CTA is available', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en');
    await expect(page.getByRole('heading', { name: 'SteamReveal', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Questions or suggestions\?/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Send Feedback$/i })).toBeVisible();
  });

  test('Language switcher changes locale and preserves the current route', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await page.getByRole('button', { name: /English - Toggle language menu/i }).click();
    await page.getByRole('menuitem', { name: /Português/i }).click();

    await expect(page).toHaveURL(/\/pt\/player\/player-a$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({ timeout: 15000 });
  });

  test('Feedback modal submits without breaking the page', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en');
    await page.getByRole('button', { name: /^Send Feedback$/i }).click();
    await page.getByPlaceholder(/Write your feedback here/i).fill('Nice project');
    await page.getByRole('button', { name: /^Send$/i }).click();

    await expect(page.getByText(/Feedback sent\. Thanks\!/i)).toBeVisible({ timeout: 15000 });
  });

  test('Feedback modal shows rate-limit error when the API rejects the request', async ({ page }) => {
    await routeApiMocks(page);
    await page.route('**/api/feedback', async (route) => {
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests.' }),
      });
    });

    await page.goto('/en');
    await page.getByRole('button', { name: /^Send Feedback$/i }).click();
    await page.getByPlaceholder(/Write your feedback here/i).fill('Nice project');
    await page.getByRole('button', { name: /^Send$/i }).click();

    await expect(page.getByText(/Too many requests\. Please wait a moment and try again\./i)).toBeVisible({ timeout: 15000 });
  });

  test('Empty manual search is blocked and keeps the page on the home route', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en');
    await page.getByRole('textbox').fill('   ');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole('textbox')).toHaveValue('   ');
    await expect(page.locator('text=User-')).toHaveCount(0);
  });

  test('Unsupported locale route renders the app 404 fallback page', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/fr');

    await expect(page.getByText(/Something went wrong!/i)).toBeVisible({ timeout: 15000 });
  });

  test('Legacy query player redirects to the locale player route', async ({ page }) => {    await routeApiMocks(page);

    await page.goto('/en?player=player-a&utm_source=demo');

    await expect(page).toHaveURL(/\/en\/player\/player-a\?utm_source=demo$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({ timeout: 15000 });
    await expectNoLocationSkeletons(page);
  });

  test('Valid player loads user card and location section appears (no persistent skeleton)', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({ timeout: 15000 });
    await expectNoLocationSkeletons(page);
  });

  test('Manual search from home resolves the target and navigates to the player route', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en');
    await expect(page.getByRole('heading', { name: /^SteamReveal$/ })).toBeVisible();

    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({ timeout: 15000 });
    await expectNoLocationSkeletons(page);
  });

  test('Navigating from the player route back to home resets to the welcome state', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({ timeout: 15000 });

    await page.goto('/en');

    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole('heading', { name: /^SteamReveal$/ })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=User-player-a')).toHaveCount(0);
  });

  test('Browser history restores the previous player after swapping profiles', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({ timeout: 15000 });

    await page.goto('/en/player/player-b');
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({ timeout: 15000 });

    await page.goBack();
    await expect(page).toHaveURL(/\/en\/player\/player-a$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({ timeout: 15000 });

    await page.goForward();
    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({ timeout: 15000 });
  });

  test('Manual invalid search shows a toast and keeps the home screen stable', async ({ page }) => {
    await routeApiMocks(page);
    await page.route('**/api/getSteamId', async (route) => {
      const url = new URL(route.request().url());
      const target = url.searchParams.get('target');
      if (!target || target === 'estainvalido' || target === 'invalid') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Invalid target.' }),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ steamId: target }),
      });
    });

    await page.goto('/en');
    await page.getByRole('textbox').fill('estainvalido');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page.getByText(/This is not a valid/)).toBeVisible({ timeout: 15000 });
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('text=User-estainvalido')).toHaveCount(0);
  });

  test('Invalid player does not leave skeletons visible', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/estainvalido');
    await page.waitForTimeout(1000);

    await expect(page.locator('text=User-estainvalido')).toHaveCount(0);
    await expectNoLocationSkeletons(page);
  });

  test('Swapping player during session produces fresh skeleton instance and new user content', async ({ page }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({ timeout: 15000 });

    await page.goto('/en/player/player-b');
    await expect(page.locator('text=User-player-b')).toBeVisible({ timeout: 15000 });

    await expectNoLocationSkeletons(page);
  });
});

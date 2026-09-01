import { test, expect } from './support/fixtures';
import { expectNoLocationSkeletons } from './support/assertions';

test.describe('Search & Routing', () => {
  test('Empty manual search is blocked and keeps the page on the home route', async ({
    page,
  }) => {
    await page.goto('/en');
    await page.getByRole('textbox').fill('   ');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole('textbox')).toHaveValue('   ');
    await expect(page.locator('text=User-')).toHaveCount(0);
  });

  test('Legacy query player redirects to the locale player route', async ({
    page,
  }) => {
    await page.goto('/en?player=player-a&utm_source=demo');

    await expect(page).toHaveURL(/\/en\/player\/player-a\?utm_source=demo$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await expectNoLocationSkeletons(page);
  });

  test('Valid player loads user card and location section appears (no persistent skeleton)', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await expectNoLocationSkeletons(page);
  });

  test('Manual search from home resolves the target and navigates to the player route', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible();

    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });
    await expectNoLocationSkeletons(page);
  });

  test('Pressing Enter in the search input triggers the search, same as the button', async ({
    page,
  }) => {
    await page.goto('/en');
    await page.getByRole('textbox').fill('player-a');
    await page.getByRole('textbox').press('Enter');

    await expect(page).toHaveURL(/\/en\/player\/player-a$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
  });

  test('Navigating from the player route back to home resets to the welcome state', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.goto('/en');

    await expect(page).toHaveURL(/\/en$/);
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=User-player-a')).toHaveCount(0);
  });

  test('Browser history restores the previous player after swapping profiles', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.goto('/en/player/player-b');
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });

    await page.goBack();
    await expect(page).toHaveURL(/\/en\/player\/player-a$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.goForward();
    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });
  });

  test('Manual invalid search shows a toast and keeps the home screen stable', async ({
    page,
  }) => {
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

    await expect(page.getByText(/This is not a valid/)).toBeVisible({
      timeout: 15000,
    });
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('text=User-estainvalido')).toHaveCount(0);
  });

  test('Invalid player does not leave skeletons visible', async ({ page }) => {
    await page.goto('/en/player/estainvalido');
    await page.waitForTimeout(1000);

    await expect(page.locator('text=User-estainvalido')).toHaveCount(0);
    await expectNoLocationSkeletons(page);
  });

  test('Swapping player during session produces fresh skeleton instance and new user content', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.goto('/en/player/player-b');
    await expect(page.locator('text=User-player-b')).toBeVisible({
      timeout: 15000,
    });

    await expectNoLocationSkeletons(page);
  });

  // Guards the `targetInfoJson ?? initialProfile` fallback added for the
  // LCP fix in Home.tsx: it prefers stale context data over the fresh
  // SSR-provided `initialProfile` until seedInitialProfile's
  // useLayoutEffect runs. If that effect is ever made async, this should
  // catch the flash of the previous player's nickname.
  test('Swapping player never shows the previous nickname once the URL has changed', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await page.waitForURL(/\/en\/player\/player-b$/, { timeout: 15000 });
    await expect(page.getByText('Nickname: User-player-a')).toHaveCount(0);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });
  });

  test('Swapping player via browser back/forward never shows the wrong stale nickname mid-transition', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.goto('/en/player/player-b');
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });

    await page.goBack();
    await page.waitForURL(/\/en\/player\/player-a$/, { timeout: 15000 });
    await expect(page.getByText('Nickname: User-player-b')).toHaveCount(0);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
  });
});

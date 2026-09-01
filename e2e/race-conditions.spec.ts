import { test, expect } from './support/fixtures';

test.describe('Race Conditions', () => {
  test('A stale fetchSteamId response does not navigate over a newer search', async ({
    page,
  }) => {
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    await page.route('**/api/getSteamId*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('target') === 'player-a') {
        await gate;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ steamId: url.searchParams.get('target') }),
      });
    });

    await page.goto('/en');
    await page.getByRole('textbox').fill('player-a');
    await page.getByRole('button', { name: /search/i }).click();

    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-b$/, { timeout: 15000 });
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });

    releaseA();
    await page.waitForTimeout(500);

    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-a')).toHaveCount(0);
  });
});

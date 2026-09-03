import { test, expect } from './support/fixtures';
import { ANTICHEAT_BUTTON_NAME } from './support/constants';
import { makeMockCheaterProbability } from '@/mocks/devFixtures';

test.describe('Cheater Report', () => {
  test('Cheater report shows a skeleton while loading, then renders the ReportBox', async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/getCheaterProbability', async (route) => {
      await gate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeMockCheaterProbability()),
      });
    });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    // CheaterReportSkeleton: bg-purple-900 + border-2 (shared with the real
    // ReportBox) + border-white + animate-pulse (unique to the skeleton —
    // the real ReportBox always uses an outcome color, never border-white).
    await expect(
      page.locator('.bg-purple-900.border-2.border-white.animate-pulse'),
    ).toBeVisible({ timeout: 5000 });

    release();

    await expect(
      page.locator('.bg-purple-900.border-2.border-white.animate-pulse'),
    ).toHaveCount(0);
    await expect(page.locator('.bg-purple-900.border-2')).toBeVisible({
      timeout: 15000,
    });
  });

  test('Cheater report button computes and renders a ReportBox', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    const reportBox = page.locator(
      '.bg-purple-900.border-2:not(.border-white)',
    );

    await expect(reportBox).toBeVisible({ timeout: 15000 });
  });

  test('Cheater report shows an error toast when the API fails, and no ReportBox renders', async ({
    page,
  }) => {
    await page.route('**/api/getCheaterProbability', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fail' }),
      }),
    );

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    // Hardcoded string in useCheaterProbability.ts, not translated.
    await expect(
      page.getByText('Failed to calculate cheater probability'),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.bg-purple-900.border-2')).toHaveCount(0);
  });

  test('Cheater report shows the error + "Try again" and recovers on retry', async ({
    page,
  }) => {
    // First call fails (500), the "Try again" retry returns real data. A
    // closure counter keys the mock so the recovery path is exercised.
    let calls = 0;
    await page.route('**/api/getCheaterProbability', (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'fail' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeMockCheaterProbability()),
      });
    });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    // The manual click failure surfaces the in-report error state (i18n key
    // resolves to the translated string) with a retry button.
    const retryButton = page.getByRole('button', { name: 'Try again' });
    await expect(retryButton).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText("We couldn't calculate the cheater probability right now. Please try again."),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.bg-purple-900.border-2')).toHaveCount(0);

    retryButton.click();

    // The retry re-runs the request; now it succeeds and the ReportBox renders.
    const reportBox = page.locator('.bg-purple-900.border-2:not(.border-white)');
    await expect(reportBox).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText("We couldn't calculate the cheater probability right now. Please try again."),
    ).toHaveCount(0);
  });

  test('Cheater report disables "Try again" during the retry cooldown (15s)', async ({
    page,
  }) => {
    await page.route('**/api/getCheaterProbability', (route) =>
      route.abort(),
    );

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    const retryButton = page.getByRole('button', { name: 'Try again' });
    await expect(retryButton).toBeVisible({ timeout: 15000 });

    retryButton.click();

    // Immediately after a tap the button is locked for the 15s cooldown —
    // a repeat click cannot re-queue the failing request.
    await expect(retryButton).toBeDisabled();
  });

  test('High cheater probability renders a red (highly-suspect) ReportBox', async ({
    page,
  }) => {
    await page.route('**/api/getCheaterProbability', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cheaterProbability: 0.9,
          featureObject: { bannedFriendsDetails: [] },
        }),
      }),
    );

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    // cheaterProbability > 0.8 -> ReportOutcomes.HIGHLY_SUSPECT -> color
    // 'red' -> borderColorClasses.red = 'border-red-500'.
    await expect(
      page.locator('.bg-purple-900.border-2.border-red-500'),
    ).toBeVisible({ timeout: 15000 });
  });

  test('Low cheater probability renders a dark-green (very-trusted) ReportBox', async ({
    page,
  }) => {
    await page.route('**/api/getCheaterProbability', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cheaterProbability: 0.05,
          featureObject: { bannedFriendsDetails: [] },
        }),
      }),
    );

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    // cheaterProbability <= 0.2 -> ReportOutcomes.VERY_TRUSTED -> color
    // 'dark-green' -> borderColorClasses['dark-green'] = 'border-emerald-600'.
    await expect(
      page.locator('.bg-purple-900.border-2.border-emerald-600'),
    ).toBeVisible({ timeout: 15000 });
  });

  test('Mid-range cheater probability renders a yellow (inconclusive) ReportBox', async ({
    page,
  }) => {
    await page.route('**/api/getCheaterProbability', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cheaterProbability: 0.5,
          featureObject: { bannedFriendsDetails: [] },
        }),
      }),
    );

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    // 0.4 <= cheaterProbability <= 0.6 -> ReportOutcomes.INCONCLUSIVE ->
    // color 'yellow' -> borderColorClasses.yellow = 'border-yellow-500'.
    await expect(
      page.locator('.bg-purple-900.border-2.border-yellow-500'),
    ).toBeVisible({ timeout: 15000 });
  });

  // Moved from the old ungrouped test list — this is a cheater-report
  // regression (the dynamic import used to fail silently under throttling),
  // not a generic environment check.
  test('Cheater report still loads correctly under slower network (dynamic import regression)', async ({
    page,
    context,
  }) => {
    const client = await context.newCDPSession(page);
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (500 * 1024) / 8,
      uploadThroughput: (500 * 1024) / 8,
      latency: 200,
    });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 20000,
    });

    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();
    const reportBox = page.locator(
      '.bg-purple-900.border-2:not(.border-white)',
    );
    await expect(reportBox).toBeVisible({ timeout: 20000 });
  });
});

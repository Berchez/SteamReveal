import { test, expect } from './support/fixtures';

test.describe('Home & Feedback', () => {
  test('Home welcome section remains visible and the feedback CTA is available', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: 'SteamReveal', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Questions or suggestions\?/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Send Feedback$/i }),
    ).toBeVisible();
  });

  test('Language switcher changes locale and preserves the current route', async ({
    page,
  }) => {
    await page.goto('/en/player/player-a');
    await page
      .getByRole('button', { name: /English - Toggle language menu/i })
      .click();
    await page.getByRole('menuitem', { name: /Português/i }).click();

    await expect(page).toHaveURL(/\/pt\/player\/player-a$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
  });

  test('Feedback modal submits without breaking the page', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('button', { name: /^Send Feedback$/i }).click();
    await page
      .getByPlaceholder(/Write your feedback here/i)
      .fill('Nice project');
    await page.getByRole('button', { name: /^Send$/i }).click();

    await expect(page.getByText(/Feedback sent\. Thanks\!/i)).toBeVisible({
      timeout: 15000,
    });
  });

  test('Feedback modal shows rate-limit error when the API rejects the request', async ({
    page,
  }) => {
    await page.route('**/api/feedback', async (route) => {
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests.' }),
      });
    });

    await page.goto('/en');
    await page.getByRole('button', { name: /^Send Feedback$/i }).click();
    await page
      .getByPlaceholder(/Write your feedback here/i)
      .fill('Nice project');
    await page.getByRole('button', { name: /^Send$/i }).click();

    await expect(
      page.getByText(
        /Too many requests\. Please wait a moment and try again\./i,
      ),
    ).toBeVisible({ timeout: 15000 });
  });

  test('Unsupported locale route renders the app 404 fallback page', async ({
    page,
  }) => {
    await page.goto('/fr');

    await expect(page.getByText(/Something went wrong!/i)).toBeVisible({
      timeout: 15000,
    });
  });
});

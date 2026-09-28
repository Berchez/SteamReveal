import { test, expect } from './support/fixtures';
import { seedShowThresholds } from './support/mocks';

// Confirmed from useSponsorMe.ts: handleShowSponsorMe reads localStorage
// 'visitCount'; shows the modal when count >= 2, and ALWAYS increments the
// stored count by 1 regardless. onCloseSponsorMe(days) sets 'visitCount'
// to `days` (0 on plain close, -30 on "don't ask again").
test.describe('SponsorMe', () => {
  test('SponsorMe appears on the 3rd search/visit and a plain close resets the counter', async ({
    page,
  }) => {
    await seedShowThresholds(page, { visitCount: 2 });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    const sponsorLink = page.locator(
      'a[href="https://github.com/Berchez/SteamReveal"]',
    );
    await expect(sponsorLink).toBeVisible({ timeout: 15000 });

    const sponsorModal = page.locator('div.fixed.inset-0.z-50', {
      has: sponsorLink,
    });
    // dontAskAgain is BEFORE the "×" close button in SponsorMe.tsx's DOM order.
    await sponsorModal.locator('button').last().click();
    await expect(sponsorLink).toHaveCount(0);

    // In-app search (client-side routing) — a page.goto here would re-run
    // addInitScript and re-seed visitCount, masking the reset.
    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });
    await expect(sponsorLink).toHaveCount(0);
  });

  test('Dismissing SponsorMe with "don\'t ask again" suppresses it on the very next visit', async ({
    page,
  }) => {
    await seedShowThresholds(page, { visitCount: 2 });

    await page.goto('/en/player/player-a');
    const sponsorLink = page.locator(
      'a[href="https://github.com/Berchez/SteamReveal"]',
    );
    await expect(sponsorLink).toBeVisible({ timeout: 15000 });

    const sponsorModal = page.locator('div.fixed.inset-0.z-50', {
      has: sponsorLink,
    });
    // dontAskAgain is the FIRST button in SponsorMe.tsx's DOM order.
    await sponsorModal.locator('button').first().click();
    await expect(sponsorLink).toHaveCount(0);

    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(page.getByText('Nickname: User-player-b')).toBeVisible({
      timeout: 15000,
    });
    await expect(sponsorLink).toHaveCount(0);
  });
});

// Confirmed from useSupportMe.ts: handleShowSupportMe(value) reads
// 'supportMeVisitCount', adds `value`, and shows the modal once the
// running total is >= 10. handleGetInfoClick calls handleShowSupportMe(1)
// on every search; useCheaterProbability calls handleShowSupportMe(3) on
// every cheater check.
test.describe('SupportMe', () => {
  test('SupportMe appears once the threshold is reached via a normal search', async ({
    page,
  }) => {
    // 9 + 1 (from the search) = 10 -> shows.
    await seedShowThresholds(page, { supportMeVisitCount: 9 });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    const stripeTab = page.getByRole('button', { name: 'STRIPE' });
    await expect(stripeTab).toBeVisible({ timeout: 15000 });

    const supportModal = page.locator('div.fixed.inset-0.z-50', {
      has: stripeTab,
    });
    // The "×" close button is the FIRST button rendered in SupportMe.tsx.
    await supportModal.locator('button').first().click();
    await expect(stripeTab).toHaveCount(0);
  });

  test('SupportMe appears after requesting the cheater report (weight 3)', async ({
    page,
  }) => {
    // Search adds +1 (6 -> 7, still under 10); the cheater check adds +3
    // (7 -> 10), which is what should tip it over.
    await seedShowThresholds(page, { supportMeVisitCount: 6 });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page
      .getByRole('button', { name: 'CS2 Anticheat Review - with AI' })
      .click();

    await expect(page.getByRole('button', { name: 'STRIPE' })).toBeVisible({
      timeout: 15000,
    });
  });

  test('SupportMe counter persists correctly across searches below the threshold', async ({
    page,
  }) => {
    await seedShowThresholds(page, { supportMeVisitCount: 3 });

    await page.goto('/en/player/player-a');

    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page.getByRole('button', { name: 'STRIPE' })).toHaveCount(0);

    const stored = await page.evaluate(() =>
      localStorage.getItem('supportMeVisitCount'),
    );
    expect(stored).toBe('5');
  });
});

// LoginPrompt mirrors the SupportMe scoring model (weighted points, same
// +1/search and +3/cheater-report call sites) with its own counter and its
// own 10-point threshold. The session gate below is overridden to logged-out
// (401) so the tests don't depend on real session state; the beacon route
// itself is covered by the shared routeApiMocks fulfill.
test.describe('LoginPrompt', () => {
  const mockLoggedOut = async (page: any) => {
    await page.route('**/api/watch/status', async (route: any) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'no session' }),
      }),
    );
  };

  const loginCta = (page: any) =>
    page.getByRole('link', { name: 'Sign in with Steam' });

  test('appears once the score threshold is reached via a normal search', async ({
    page,
  }) => {
    // 9 + 1 (from the search) = 10 -> shows (logged-out gate mocked).
    await seedShowThresholds(page, { loginPromptScore: 9 });
    await mockLoggedOut(page);

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await expect(loginCta(page)).toBeVisible({ timeout: 15000 });
  });

  test('CTA click fires the popup beacon (never the navbar one)', async ({
    page,
  }) => {
    await seedShowThresholds(page, { loginPromptScore: 9 });
    await mockLoggedOut(page);

    await page.goto('/en/player/player-a');
    await expect(loginCta(page)).toBeVisible({ timeout: 15000 });

    const [request] = await Promise.all([
      page.waitForRequest(
        (req: any) =>
          req.url().includes('/api/recordAnalyticsLogin') &&
          req.method() === 'POST',
      ),
      loginCta(page).click(),
    ]);
    // The click navigates away to Steam right after firing: assert on the
    // captured request only, nothing on the (departed) page.
    expect(request.postDataJSON().event).toBe('login_popup_cta_clicked');
  });

  test('dismiss with "don\'t ask again" suppresses it on the very next visit', async ({
    page,
  }) => {
    await seedShowThresholds(page, { loginPromptScore: 9 });
    await mockLoggedOut(page);

    await page.goto('/en/player/player-a');
    await expect(loginCta(page)).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: "Don't ask again" }).click();
    await expect(loginCta(page)).toHaveCount(0);

    // In-app search (client-side routing) — a page.goto here would re-run
    // addInitScript and re-seed the score, masking the -50 debt.
    await page.getByRole('textbox').fill('player-b');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-b$/);
    await expect(loginCta(page)).toHaveCount(0);
    // -50 debt from dismiss, +1 from the follow-up search.
    const stored = await page.evaluate(() =>
      localStorage.getItem('loginPromptScore'),
    );
    expect(stored).toBe('-49');
  });

  test('yields to the monetization modals when thresholds collide', async ({
    page,
  }) => {
    // Both SupportMe (9+1) and the login prompt (9+1) cross at once: only
    // one modal may show, and the donation flow wins over the login ask.
    await seedShowThresholds(page, {
      supportMeVisitCount: 9,
      loginPromptScore: 9,
    });
    await mockLoggedOut(page);

    await page.goto('/en/player/player-a');
    await expect(page.getByRole('button', { name: 'STRIPE' })).toBeVisible({
      timeout: 15000,
    });
    await expect(loginCta(page)).toHaveCount(0);
  });
});

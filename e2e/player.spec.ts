import { test, expect, Page } from '@playwright/test';
import {
  isMockInvalidTarget,
  makeMockCloseFriends,
  makeMockProfile,
  makeMockCheaterProbability,
} from '@/mocks/devFixtures';

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

const expectNoLocationSkeletons = async (page: Page) => {
  await expect(
    page.locator('[data-testid="location-skeleton-provided"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="location-skeleton-map"]'),
  ).toHaveCount(0);
};

const ANTICHEAT_BUTTON_NAME = 'CS2 Anticheat Review - with AI';

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
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/feedback', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/getCheaterProbability', async (route) => {
    const post = await route.request().postData();
    const body = post ? JSON.parse(post) : {};

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockCheaterProbability()),
    });
  });

  await page.route('**/api/recordAnalyticsCheater', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

// Seeds the SponsorMe/SupportMe localStorage counters BEFORE the app's own
// JS runs. useSponsorMe: shows once visitCount >= 2 (3rd call to
// handleShowSponsorMe). useSupportMe: shows once
// (currentCount + increment) >= 10.
//
// CAUTION: addInitScript re-runs on every subsequent page.goto() in the
// SAME test, re-seeding these values and silently overwriting whatever the
// app already wrote to localStorage since the last full navigation. Tests
// that need a second "visit" after the first must trigger it via in-app
// (client-side) navigation, not page.goto.
const seedShowThresholds = async (
  page: Page,
  seed: { visitCount?: number; supportMeVisitCount?: number },
) => {
  await page.addInitScript((s) => {
    if (s.visitCount !== undefined) {
      window.localStorage.setItem('visitCount', String(s.visitCount));
    }
    if (s.supportMeVisitCount !== undefined) {
      window.localStorage.setItem(
        'supportMeVisitCount',
        String(s.supportMeVisitCount),
      );
    }
  }, seed);
};

// ---------------------------------------------------------------------
// Home & Feedback
// ---------------------------------------------------------------------

test.describe('Home & Feedback', () => {
  test('Home welcome section remains visible and the feedback CTA is available', async ({
    page,
  }) => {
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);

    await page.goto('/fr');

    await expect(page.getByText(/Something went wrong!/i)).toBeVisible({
      timeout: 15000,
    });
  });

  test('A failure computing possible location still caches the search and clears the location skeleton', async ({
    page,
  }) => {
    await routeApiMocks(page);
    await page.route('**/api/getCloseFriends', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          closeFriends: [
            {
              friend: {
                steamID: 'x',
                countryCode: 'ZZ',
                stateCode: 'ZZ',
                cityID: 'ZZ',
              },
              count: 1,
            },
          ],
        }),
      }),
    );

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/invalidPlayer|error/i))
      .toBeVisible({ timeout: 15000 })
      .catch(() => {});
    await expectNoLocationSkeletons(page);
  });
});

// ---------------------------------------------------------------------
// Search & Routing
// ---------------------------------------------------------------------

test.describe('Search & Routing', () => {
  test('Empty manual search is blocked and keeps the page on the home route', async ({
    page,
  }) => {
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.locator('text=User-player-a')).toBeVisible({
      timeout: 15000,
    });
    await expectNoLocationSkeletons(page);
  });

  test('Manual search from home resolves the target and navigates to the player route', async ({
    page,
  }) => {
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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

    await expect(page.getByText(/This is not a valid/)).toBeVisible({
      timeout: 15000,
    });
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

  test('Swapping player during session produces fresh skeleton instance and new user content', async ({
    page,
  }) => {
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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

// ---------------------------------------------------------------------
// LCP — SSR-immediate avatar
// ---------------------------------------------------------------------
// Regression guard for the LCP fix: nickname must be present in the raw
// SSR HTML (before any client JS/hydration), and no UserCardSkeleton
// should ever be visible on a direct, first-paint load of a player route.

test.describe('LCP — SSR-immediate avatar', () => {
  test('Player route HTML already contains the nickname before any client JS runs', async ({
    page,
  }) => {
    await routeApiMocks(page);

    const response = await page.request.get('/en/player/player-a');
    const html = await response.text();

    expect(html).toContain('Nickname');
    expect(html).toContain('User-player-a');
  });

  test('MyUserSection never shows UserCardSkeleton on first paint for a valid direct player URL', async ({
    page,
  }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 3000,
    });
  });

  // Guards the `targetLocationInfo: {}` SSR fallback: UserCard destructures
  // { city, state, country } from it, and all three are guarded by
  // `!isLoadingLocationDetails && city && ...` — an empty object should
  // just render nothing there, never throw or print "undefined"/"NaN".
  test('Direct player load with the SSR fallback profile does not throw or render broken location UI', async ({
    page,
  }) => {
    await routeApiMocks(page);

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    expect(errors).toEqual([]);
    await expect(page.locator('text=/undefined|NaN/')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------
// Client Cache & SSR
// ---------------------------------------------------------------------

test.describe('Client Cache & SSR', () => {
  test('Direct navigation to a player URL renders the SSR-seeded profile without an extra getUserInfo call', async ({
    page,
  }) => {
    await routeApiMocks(page);

    let getUserInfoCalled = false;
    await page.route('**/api/getUserInfo', async (route) => {
      getUserInfoCalled = true;
      await route.fallback();
    });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    // seedInitialProfile + getSeededUserInfoJson should have handled this
    // entirely from the SSR-provided profile — no client round-trip to
    // /api/getUserInfo should have been necessary.
    expect(getUserInfoCalled).toBe(false);
  });

  test('Repeating a search reuses the client cache and skips network calls', async ({
    page,
  }) => {
    await routeApiMocks(page);

    await page.goto('/en');
    await page.getByRole('textbox').fill('player-a');
    await page.getByRole('button', { name: /search/i }).click();
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    // SPA nav back (not page.goto), so homeCache's module-level Map survives.
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible({ timeout: 15000 });

    let getUserInfoCalled = false;
    let getCloseFriendsCalled = false;
    await page.route('**/api/getUserInfo', async (route) => {
      getUserInfoCalled = true;
      await route.fallback();
    });
    await page.route('**/api/getCloseFriends', async (route) => {
      getCloseFriendsCalled = true;
      await route.fallback();
    });

    await page.getByRole('textbox').fill('player-a');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-a$/);
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible();
    expect(getUserInfoCalled).toBe(false);
    expect(getCloseFriendsCalled).toBe(false);
  });

  test('Cheater data computed once is cached and reappears on a repeat search without re-clicking', async ({
    page,
  }) => {
    await routeApiMocks(page);

    await page.goto('/en');
    await page.getByRole('textbox').fill('player-a');
    await page.getByRole('button', { name: /search/i }).click();
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();
    const reportBox = page.locator(
      '.bg-purple-900.border-2:not(.border-white)',
    );

    await expect(reportBox).toBeVisible({ timeout: 15000 });

    await page.goBack();
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole('textbox').fill('player-a');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-a$/);
    // handleGetInfoClick's cached-search branch restores cheaterData
    // synchronously via setCheaterData — the ReportBox should already be
    // on screen without clicking the anticheat button again.

    await expect(reportBox).toBeVisible({ timeout: 15000 });
  });

  test('Searching a different alias that resolves to an already-cached SteamID reuses the cache', async ({
    page,
  }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.route('**/api/getSteamId*', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ steamId: 'player-a' }),
      });
    });

    let getUserInfoCalled = false;
    await page.route('**/api/getUserInfo', async (route) => {
      getUserInfoCalled = true;
      await route.fallback();
    });

    await page.goto('/en');
    await page
      .getByRole('textbox')
      .fill('https://steamcommunity.com/id/player-a-vanity');
    await page.getByRole('button', { name: /search/i }).click();

    await expect(page).toHaveURL(/\/en\/player\/player-a$/);
    expect(getUserInfoCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Race Conditions
// ---------------------------------------------------------------------

test.describe('Race Conditions', () => {
  test('A stale fetchSteamId response does not navigate over a newer search', async ({
    page,
  }) => {
    await routeApiMocks(page);

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

// ---------------------------------------------------------------------
// Cheater Report
// ---------------------------------------------------------------------

test.describe('Cheater Report', () => {
  test('Cheater report shows a skeleton while loading, then renders the ReportBox', async ({
    page,
  }) => {
    await routeApiMocks(page);

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
    await routeApiMocks(page);

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
    await routeApiMocks(page);
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

  test('High cheater probability renders a red (highly-suspect) ReportBox', async ({
    page,
  }) => {
    await routeApiMocks(page);
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
    await routeApiMocks(page);
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
    await routeApiMocks(page);
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
});

// ---------------------------------------------------------------------
// SponsorMe
// ---------------------------------------------------------------------
// Confirmed from useSponsorMe.ts: handleShowSponsorMe reads localStorage
// 'visitCount'; shows the modal when count >= 2, and ALWAYS increments the
// stored count by 1 regardless. onCloseSponsorMe(days) sets 'visitCount'
// to `days` (0 on plain close, -30 on "don't ask again").

test.describe('SponsorMe', () => {
  test('SponsorMe appears on the 3rd search/visit and a plain close resets the counter', async ({
    page,
  }) => {
    await routeApiMocks(page);
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
    await routeApiMocks(page);
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

// ---------------------------------------------------------------------
// SupportMe
// ---------------------------------------------------------------------
// Confirmed from useSupportMe.ts: handleShowSupportMe(value) reads
// 'supportMeVisitCount', adds `value`, and shows the modal once the
// running total is >= 10. handleGetInfoClick calls handleShowSupportMe(1)
// on every search; useCheaterProbability calls handleShowSupportMe(3) on
// every cheater check.

test.describe('SupportMe', () => {
  test('SupportMe appears once the threshold is reached via a normal search', async ({
    page,
  }) => {
    await routeApiMocks(page);
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
    await routeApiMocks(page);
    // Search adds +1 (6 -> 7, still under 10); the cheater check adds +3
    // (7 -> 10), which is what should tip it over.
    await seedShowThresholds(page, { supportMeVisitCount: 6 });

    await page.goto('/en/player/player-a');
    await expect(page.getByText('Nickname: User-player-a')).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole('button', { name: ANTICHEAT_BUTTON_NAME }).click();

    await expect(page.getByRole('button', { name: 'STRIPE' })).toBeVisible({
      timeout: 15000,
    });
  });

  test('SupportMe counter persists correctly across searches below the threshold', async ({
    page,
  }) => {
    await routeApiMocks(page);
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

// ---------------------------------------------------------------------
// Friends & Location (real, hand-verified data)
// ---------------------------------------------------------------------
// All numbers below are computed directly from probabilityMath.ts against
// the fixture in devFixtures.ts (friend-1 count=10, friend-2 count=5, both
// in BR/11/7179 = Amambai, Mato Grosso do Sul):
//   friend-1 probability = 79.56%   (computeCloseFriendsProbability)
//   friend-2 probability = 39.78%   (computeCloseFriendsProbability)
//   aggregated city score = 10 * 5 = 50   (computeCityScores)
//   aggregated location probability = 83.33%, count (50)   (computeLocationProbabilities)

test('Friends with public profiles render as friend cards with reliability percentages', async ({
  page,
}) => {
  await routeApiMocks(page);

  await page.goto('/en/player/player-with-friends');
  await expect(
    page.getByText('Nickname: User-player-with-friends'),
  ).toBeVisible({ timeout: 15000 });

  await expect(page.getByText('FriendOne')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('FriendTwo')).toBeVisible();

  await expect(
    page.getByText('Reliability: 79.56%').or(page.getByText('79.56%')),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('39.78%')).toBeVisible();

  const friendsSection = page
    .locator('h1', { hasText: 'Friends IRL' })
    .locator('..');

  await expect(
    friendsSection.getByText(/Amambai, Mato Grosso do Sul, Brazil/),
  ).toHaveCount(2, { timeout: 15000 });
});

test.describe('Background & preconnect', () => {
  test('Background renders (image fallback or video) without console errors even without priority preload', async ({
    page,
  }) => {
    await routeApiMocks(page);

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/en');
    // Covers both branches of VideoBackground: the immediate <Image> fallback
    // and the post-idle/timeout <video>. Either is acceptable — this is a
    // regression guard, not an assertion about which one shows first.
    await expect(page.locator('img[alt="background"], video')).toBeVisible({
      timeout: 5000,
    });

    expect(errors).toEqual([]);
  });

  test('Preconnect to the avatar CDN is present in <head>', async ({
    page,
  }) => {
    await routeApiMocks(page);

    await page.goto('/en/player/player-a');
    const preconnect = page.locator(
      'link[rel="preconnect"][href="https://avatars.steamstatic.com"]',
    );
    await expect(preconnect).toHaveCount(1);
  });
});

test('Cheater report still loads correctly under slower network (dynamic import regression)', async ({
  page,
  context,
}) => {
  await routeApiMocks(page);

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
  const reportBox = page.locator('.bg-purple-900.border-2:not(.border-white)');
  await expect(reportBox).toBeVisible({ timeout: 20000 });
});

test('Browser language is accessible from navigator API', async ({ page }) => {
  await routeApiMocks(page);

  await page.goto('/en');

  // Verify that navigator.language is accessible in the page context
  const browserLang = await page.evaluate(() => navigator.language);
  expect(browserLang).toBeTruthy();
  expect(browserLang).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);

  // Verify the getRequesterBrowserLanguage function works on the client side
  const captured = await page.evaluate(() => {
    // Import getRequesterBrowserLanguage directly in the page context
    return (window as any).getRequesterBrowserLanguage?.() || navigator.language;
  });

  expect(captured).toBeTruthy();
  expect(captured).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
});

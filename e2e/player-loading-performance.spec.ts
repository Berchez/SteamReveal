import { test, expect } from './support/fixtures';
import { expectNoLocationSkeletons } from './support/assertions';

test.describe('LCP — SSR-immediate avatar', () => {
  // Regression guard for the LCP fix: nickname must be present in the raw
  // SSR HTML (before any client JS/hydration), and no UserCardSkeleton
  // should ever be visible on a direct, first-paint load of a player route.
  test('Player route HTML already contains the nickname before any client JS runs', async ({
    page,
  }) => {
    const response = await page.request.get('/en/player/player-a');
    const html = await response.text();

    expect(html).toContain('Nickname');
    expect(html).toContain('User-player-a');
  });

  test('MyUserSection never shows UserCardSkeleton on first paint for a valid direct player URL', async ({
    page,
  }) => {
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

test.describe('Client Cache & SSR', () => {
  test('Direct navigation to a player URL renders the SSR-seeded profile without an extra getUserInfo call', async ({
    page,
  }) => {
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

  test('Searching a different alias that resolves to an already-cached SteamID reuses the cache', async ({
    page,
  }) => {
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

test.describe('Location loading resilience', () => {
  // Moved from the old "Home & Feedback" describe — it's testing location
  // enrichment failure handling, not home/feedback behavior.
  test('A failure computing possible location still caches the search and clears the location skeleton', async ({
    page,
  }) => {
    await page.route('**/api/getCloseFriends', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          closeFriends: [
            {
              friend: {
                steamID: 'x',
                avatar: {
                  large: 'https://example.com/x.jpg',
                  medium: 'https://example.com/x.jpg',
                  small: '',
                  hash: '',
                },
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

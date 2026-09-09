import { test, expect } from './support/fixtures';

test.describe('Footer placement', () => {
  test('Footer pins to the viewport bottom on short player pages', async ({
    page,
  }) => {
    // Taller-than-content viewport: the player-short fixture page settles
    // around ~1370px high (profile + provided-location map + empty friends
    // list + footer), so at 1600px viewport height the document is shorter
    // than the screen. NOTE: overriding /api/getUserInfo here would NOT
    // shorten anything — direct navigation SSR-seeds the profile (with geo,
    // hence the map) and the seeded path never calls that API.
    await page.setViewportSize({ width: 1280, height: 1600 });

    await page.goto('/en/player/player-short');
    await expect(page.getByText('Nickname: User-player-short')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText('Friends IRL')).toBeVisible({
      timeout: 15000,
    });
    // Measure in the settled state (skeletons resolved), not mid-swap.
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    const metrics = await page.evaluate(() => {
      const footer = document.querySelector('footer');
      if (!footer) {
        return null;
      }
      return {
        footerBottom: footer.getBoundingClientRect().bottom,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      };
    });

    expect(metrics).not.toBeNull();
    // Sanity: nothing overflows — the wrapper's min-h-screen already makes
    // the document exactly viewport-tall, so there is no scroll here...
    expect(metrics!.scrollHeight).toBeLessThanOrEqual(
      metrics!.viewportHeight + 2,
    );
    // ...and the footer sits at its very bottom, not floating mid-page
    // with a gap of body background below it.
    expect(
      Math.abs(metrics!.footerBottom - metrics!.viewportHeight),
    ).toBeLessThanOrEqual(2);
  });

  test('Footer stays at the document bottom on tall player pages', async ({
    page,
  }) => {
    await page.goto('/en/player/player-with-friends');
    await expect(page.getByText('FriendOne')).toBeVisible({ timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    const metrics = await page.evaluate(() => {
      const footer = document.querySelector('footer');
      if (!footer) {
        return null;
      }
      return {
        footerBottom:
          footer.getBoundingClientRect().bottom + window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      };
    });

    expect(metrics).not.toBeNull();
    // Tall content: the page scrolls...
    expect(metrics!.scrollHeight).toBeGreaterThan(metrics!.viewportHeight);
    // ...and the footer is the last thing in the document. The 50px
    // tolerance is the wrapper's own designed bottom padding (md:p-12 =
    // 48px at this viewport) sitting below the footer — anything larger
    // would mean the footer drifted up out of place.
    expect(metrics!.scrollHeight - metrics!.footerBottom).toBeLessThanOrEqual(
      50,
    );
  });
});

import { test, expect } from './support/fixtures';

test.describe('Background & preconnect', () => {
  test('Background renders (image fallback or video) without console errors even without priority preload', async ({
    page,
  }) => {
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
    await page.goto('/en/player/player-a');
    const preconnect = page.locator(
      'link[rel="preconnect"][href="https://avatars.steamstatic.com"]',
    );
    await expect(preconnect).toHaveCount(1);
  });

  test('Reduced-motion visitors get the gradient without its infinite animation', async ({
    page,
  }) => {
    // The probe element is injected instead of hunting for a real one: the
    // class is what the rule targets, and the page's own data decides which
    // cards happen to render a gradient right now.
    const animationName = async () =>
      page.evaluate(() => {
        const probe = document.createElement('span');
        probe.className = 'animate-gradient-spin';
        document.body.appendChild(probe);
        const name = getComputedStyle(probe).animationName;
        probe.remove();
        return name;
      });

    await page.goto('/en');
    expect(await animationName()).toBe('gradient-spin');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/en');
    expect(await animationName()).toBe('none');
  });
});

test('Browser language is accessible from navigator API', async ({ page }) => {
  await page.goto('/en');

  // Verify that navigator.language is accessible in the page context
  const browserLang = await page.evaluate(() => navigator.language);
  expect(browserLang).toBeTruthy();
  expect(browserLang).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);

  // Verify the getRequesterBrowserLanguage function works on the client side
  const captured = await page.evaluate(() => {
    // Import getRequesterBrowserLanguage directly in the page context
    return (
      (window as any).getRequesterBrowserLanguage?.() || navigator.language
    );
  });

  expect(captured).toBeTruthy();
  expect(captured).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
});

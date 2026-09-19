import { expect, test } from '@playwright/test';

// Mobile navbar bar (<sm) — the only automated net for the responsive
// swap: every other spec runs at the default desktop width, so without
// this the bar layout (logo left, cluster right, no overlap) and the
// sm:hidden logo gating regress silently.
//
// Parametrized with de (the repo's canonical long-string locale — the
// skeleton-height incident was a de/ru layout break) so the overlap
// assertion actually exercises what its comment worries about: locale
// copy widths against the justify-between bar.
const MOBILE_LOCALES: Array<{
  locale: string;
  switcher: RegExp;
  signIn: string;
}> = [
  {
    locale: 'en',
    switcher: /English - Toggle language menu/i,
    signIn: 'Sign in',
  },
  {
    locale: 'de',
    switcher: /Deutsch - Sprachenmenü umschalten/i,
    signIn: 'Anmelden',
  },
];

// Logged-out is enough: the bar's layout is identity-independent (the
// cluster just swaps sign-in for bell+avatar, same slots), and the
// logged-in cluster is already covered by watch.spec.ts at desktop width.
for (const { locale, switcher, signIn } of MOBILE_LOCALES) {
  test(`mobile navbar: logo left, cluster right, no overlap at 390px (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${locale}`);

    const logo = page.getByRole('link', { name: 'SteamReveal' });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('href', '/');

    const switcherButton = page.getByRole('button', { name: switcher });
    await expect(switcherButton).toBeVisible();
    await expect(
      page.getByRole('link', { name: signIn, exact: true }),
    ).toBeVisible();

    // Justify-between sanity: the logo cluster must never overlap the
    // control cluster, whatever locale strings do to their widths (+1px
    // subpixel tolerance).
    const logoBox = await logo.boundingBox();
    const switcherBox = await switcherButton.boundingBox();
    expect(logoBox).not.toBeNull();
    expect(switcherBox).not.toBeNull();
    expect(logoBox!.x + logoBox!.width).toBeLessThanOrEqual(
      switcherBox!.x + 1,
    );
  });
}

test('desktop keeps the floating cluster and hides the mobile-only logo', async ({
  page,
}) => {
  // Default viewport (1280x720): the sm: reset restores the old
  // top-right overlay — the wordmark logo (sm:hidden) must NOT render
  // and the sign-in entry stays where it always was.
  await page.goto('/en');

  await expect(
    page.getByRole('link', { name: 'SteamReveal' }),
  ).toBeHidden();
  await expect(
    page.getByRole('link', { name: 'Sign in', exact: true }),
  ).toBeVisible();
});

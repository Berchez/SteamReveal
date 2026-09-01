import { expect, Page } from '@playwright/test';

export const expectNoLocationSkeletons = async (page: Page) => {
  await expect(
    page.locator('[data-testid="location-skeleton-provided"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="location-skeleton-map"]'),
  ).toHaveCount(0);
};

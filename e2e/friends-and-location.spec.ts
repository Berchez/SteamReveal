import { test, expect } from './support/fixtures';

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

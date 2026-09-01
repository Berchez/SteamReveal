import { Page } from '@playwright/test';
import {
  isMockInvalidTarget,
  makeMockCloseFriends,
  makeMockProfile,
  makeMockCheaterProbability,
} from '@/mocks/devFixtures';

export async function routeApiMocks(page: Page) {
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

  await page.route('**/api/getSteamId*', async (route) => {
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

  await page.route('**/api/getGamersClubName', async (route) => {
    const req = route.request();
    const post = await req.postData();
    const body = post ? JSON.parse(post) : {};
    const steamId = body.steamId as string | undefined;

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ steamId: steamId || '', gcName: null }),
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
export const seedShowThresholds = async (
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

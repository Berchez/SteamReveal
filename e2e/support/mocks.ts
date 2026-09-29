import { Page } from '@playwright/test';
import {
  isMockInvalidTarget,
  makeMockCloseFriends,
  makeMockProfile,
  makeMockCheaterProbability,
} from '@/mocks/devFixtures';

export async function routeApiMocks(page: Page) {
  // Hermetic ads: the layout loads the AdSense script unconditionally and
  // its delivery flow spawns blank same-origin iframes (about:blank inherits
  // the page origin until it navigates away). Playwright addInitScripts —
  // including seedShowThresholds below — run in EVERY frame, so a blank ad
  // iframe initializing mid-test writes the seed counters into the SHARED
  // origin storage, resurrecting counter-gated modals nondeterministically
  // (proven live: visitCount -30 -> 2 with no in-page writer, plus
  // blank-iframe attach/detach churn). Aborting the ad/tracking domains
  // keeps e2e deterministic (and fast) without touching product behavior:
  // maps/avatars/fonts stay allowed (asserted by tests), only ad delivery
  // goes dark. shouldLoadAds already keeps ad UNITS out of non-prod; this
  // keeps the SCRIPT from even loading.
  const adHosts = [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadsyndication.com',
    'adtrafficquality.google',
  ];
  // Patterns never overlap, so registration order is irrelevant.
  await Promise.all(
    adHosts.map((host) =>
      page.route(`**/${host}/**`, (route) => route.abort()),
    ),
  );
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

  await page.route('**/api/recordAnalyticsFriends', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, updated: 0 }),
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

  await page.route('**/api/recordAnalyticsLogin', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/recordAnalyticsModals', async (route) => {
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

// Seeds the SponsorMe/SupportMe/LoginPrompt localStorage counters BEFORE the
// app's own JS runs. useSponsorMe: shows once visitCount >= 2 (3rd call to
// handleShowSponsorMe). useSupportMe: shows once
// (currentCount + increment) >= 10. useLoginPrompt: shows once
// (currentScore + points) >= 10.
//
// CAUTION: addInitScript re-runs on every subsequent page.goto() in the
// SAME test, re-seeding these values and silently overwriting whatever the
// app already wrote to localStorage since the last full navigation. Tests
// that need a second "visit" after the first must trigger it via in-app
// (client-side) navigation, not page.goto.
export const seedShowThresholds = async (
  page: Page,
  seed: {
    visitCount?: number;
    supportMeVisitCount?: number;
    loginPromptScore?: number;
  },
) => {
  await page.addInitScript((s) => {
    // addInitScript runs in EVERY frame (including blank same-origin ad
    // iframes, which inherit the page origin until they navigate away) and
    // in prerenders — all sharing the origin's localStorage with the
    // visible page. Seeding anywhere but the visible top-level document
    // overwrites the counters the flow under test already wrote (e.g. back
    // to 2 right after a dismiss wrote -30), flipping counter-gated modals
    // nondeterministically. Both guards are identity comparisons (never
    // throw cross-origin) and no-ops for real navigations/popups, which are
    // always top-level and non-prerendered when seeded.
    // (`prerendering` is cast: the repo TS DOM lib predates the API, and a
    // feature-detect keeps this working where it is absent.)
    const doc = document as Document & { prerendering?: boolean };
    if (doc.prerendering === true || window.top !== window) {
      return;
    }
    if (s.visitCount !== undefined) {
      window.localStorage.setItem('visitCount', String(s.visitCount));
    }
    if (s.supportMeVisitCount !== undefined) {
      window.localStorage.setItem(
        'supportMeVisitCount',
        String(s.supportMeVisitCount),
      );
    }
    if (s.loginPromptScore !== undefined) {
      window.localStorage.setItem(
        'loginPromptScore',
        String(s.loginPromptScore),
      );
    }
  }, seed);
};

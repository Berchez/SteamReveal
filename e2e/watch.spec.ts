import type { Page } from '@playwright/test';
import { test, expect, loginTestUser } from './support/fixtures';

// Full Watch flow E2E (navbar era) — NEVER touches Steam or a real
// database: the watch lanes + signup are fulfilled at the network layer
// (the bot side stays covered by unit/integration tests), and
// authentication goes through the TEST-ONLY seam
// (`POST /api/auth/test-login`, mock-mode gated, real iron-session crypto
// on the real Next server). No localStorage identity exists anywhere.
// Server-side guarantees (cooldown windows, idempotency, token rules)
// live in db.integration.test.ts; what THIS suite proves is the
// user-visible wiring: navbar sign-in → avatar dropdown → signup →
// pending → active → bell → inbox, opt-out, /watch redirect, the
// one-shot toasts, and the error states.
//
// NOTE on the avatar: SiteNav resolves it server-side via
// getSteamIdentity, which returns the hermetic MockUser fixture in mock
// mode (Playwright boots with DEV_TEST_MODE=1) — a data-URI pixel, so
// this suite never touches the real Steam API AND the avatar label is
// deterministic. The best-effort real-Steam path (timeout, fallback,
// TTL) is unit-covered in getSteamIdentity.test.ts instead.
const STEAM_ID = '76561198000000001';

const signupOk = () => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ ok: true }),
});

const statusBody = (status: string) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ steamId: STEAM_ID, status }),
});

const notificationsBody = (
  rows: Array<{ id: number; sentAt: string }>,
  unreadCount: number,
) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ steamId: STEAM_ID, notifications: rows, unreadCount }),
});

const row = (id: number, sentAt: string) => ({ id, sentAt });

// Deterministic in mock mode (see NOTE above): every logged-in session
// renders the MockUser avatar button.
const avatarButton = (page: Page) =>
  page.getByRole('button', { name: 'Profile picture of MockUser', exact: true });

test.describe('Watch full flow (mocked bot, real session)', () => {
  test('logged-out visitor sees the navbar sign-in, never a bell or panel', async ({
    page,
  }) => {
    await page.goto('/en');

    const loginLink = page.getByRole('link', { name: 'Sign in', exact: true });
    await expect(loginLink).toBeVisible();
    await expect(loginLink).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2F',
    );
    // No bell, no avatar panel, no notification traffic without a session.
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveCount(0);
    await expect(avatarButton(page)).toHaveCount(0);
  });

  test('login link hits the real OpenID handler (302 to Steam)', async ({
    page,
  }) => {
    await page.goto('/en');

    const responsePromise = page.waitForResponse('**/api/auth/steam/login*');
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    const response = await responsePromise;

    // The REAL login route runs (no mocks on it): 302 to Steam's endpoint
    // with a complete OpenID request. The page will sail off to
    // steamcommunity.com afterwards — assertions stop here on purpose
    // (the callback leg is unit-tested with a mocked Steam transport).
    expect(response.status()).toBe(302);
    const location = response.headers()['location'] ?? '';
    expect(location).toContain('https://steamcommunity.com/openid/login');
    expect(location).toContain('openid.mode=checkid_setup');
  });

  test('failed callback shows the one-shot login error toast', async ({
    page,
  }) => {
    await page.goto('/en/?auth=error');

    // Scoped by text: the real ToastContainer also exposes role="alert".
    await expect(
      page.getByText('Steam login failed. Try again in a moment.'),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Sign in', exact: true }),
    ).toBeVisible();

    // One-shot: the param is stripped, a reload never replays the toast.
    await expect(page).not.toHaveURL(/[?&]auth=/);
    await page.reload();
    await expect(
      page.getByText('Steam login failed. Try again in a moment.'),
    ).toHaveCount(0);
  });

  test('legacy /watch redirects home (flow lives in the navbar)', async ({
    page,
  }) => {
    await page.goto('/en/watch');
    await expect(page).toHaveURL(/\/en\/?($|\?)/);
  });

  test('signup -> pending -> active inside the avatar dropdown', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    // Creation is explicit: nothing posts until Start is hit inside the
    // dropdown panel.
    let signupCalls = 0;
    await page.route('**/api/auth/signup', async (route) => {
      signupCalls += 1;
      return route.fulfill(signupOk());
    });
    // Pre-click polls all read 'none' (stable no-watch screen no matter how
    // many polls fire); post-click polls walk pending → pending → active
    // and stick there.
    let requested = false;
    const postClick = ['pending', 'pending', 'active'];
    await page.route('**/api/watch/status', async (route) => {
      if (!requested) return route.fulfill(statusBody('none'));
      return route.fulfill(statusBody(postClick.shift() ?? 'active'));
    });
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible();
    expect(signupCalls).toBe(0);

    // The panel opens from the avatar; the signup fires on Start with
    // locale only — identity NEVER leaves the session into the body.
    await avatarButton(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible();

    const signupPromise = page.waitForRequest('**/api/auth/signup');
    await page.getByRole('button', { name: 'Watch this profile' }).click();
    requested = true;
    const signup = await signupPromise;
    expect(signup.postDataJSON()).toEqual({ locale: 'en' });

    await expect(
      page.getByRole('heading', { name: 'Invite sent' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 20000,
    });

    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute(
      'aria-label',
      'Watch notifications, 0 unread',
    );

    // The mock-mode avatar (data: URI through next/image) renders a real
    // <img> — a broken optimizer would crash this render instead.
    await expect(avatarButton(page).locator('img')).toHaveAttribute(
      'src',
      /^data:image\//,
    );
  });

  test('unlocalized confirm landing survives the middleware locale hop', async ({
    page,
  }) => {
    // The confirm route now lands locale-aware, but the bare-home form
    // (error legs, old links) still relies on the middleware redirect
    // preserving the query string: /?confirmed=ok -> /en/?confirmed=ok.
    // This test drives that exact hop (resolves against the host root,
    // not the /en baseURL) instead of navigating to /en/ directly.
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('active')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/?confirmed=ok');
    // The toast's presence proves the param survived the middleware hop
    // (/?confirmed=ok -> /en/?confirmed=ok): QueryToast strips the param
    // on mount, so no URL assertion — the toast IS the assertion.
    await expect(
      page.getByText('Watch confirmed! You will be notified here'),
    ).toBeVisible();
  });

  test('confirm landing shows the one-shot success toast', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('active')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/?confirmed=ok');
    await expect(
      page.getByText('Watch confirmed! You will be notified here'),
    ).toBeVisible();

    await expect(page).not.toHaveURL(/[?&]confirmed=/);
    await page.reload();
    await expect(
      page.getByText('Watch confirmed! You will be notified here'),
    ).toHaveCount(0);
  });

  test('cooldown re-request stays a calm pending screen (no error)', async ({
    page,
  }) => {
    // A re-request inside the 7-day window is answered pending with
    // inviteQueued:false (route unit-tested); the client shows the same
    // calm pending screen either way. Pins that visible half: no error.
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('pending')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en');
    await avatarButton(page).click();

    await expect(
      page.getByRole('heading', { name: 'Invite sent' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText('Could not start watching. Try again in a moment.'),
    ).toHaveCount(0);
  });

  test('opt-out sticks: status none never re-subscribes on revisit', async ({
    page,
  }) => {
    // Regression net for silent re-subscription: unfriend deletes the row
    // (reads as 'none'), and opening the dropdown must NOT recreate it —
    // every visit would otherwise undo the opt-out while logged in.
    await loginTestUser(page, STEAM_ID);
    let signupCalls = 0;
    await page.route('**/api/auth/signup', async (route) => {
      signupCalls += 1;
      return route.fulfill(signupOk());
    });
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('none')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en');
    await avatarButton(page).click();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({
      timeout: 15000,
    });
    await page.reload();
    await avatarButton(page).click();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({
      timeout: 15000,
    });

    expect(signupCalls).toBe(0);
  });

  test('empty inbox -> notifications arrive -> badge -> open clears -> reload persists', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('active')),
    );
    let delivered = false;
    // Watermark-aware like the real route: once the client reports a
    // sinceSentAt at/after the newest delivery, the count drops to zero.
    await page.route('**/api/watch/notifications*', async (route) => {
      if (!delivered) {
        return route.fulfill(notificationsBody([], 0));
      }
      const since = new URL(route.request().url()).searchParams.get(
        'sinceSentAt',
      );
      const seen = since !== null && since >= '2026-06-02T12:00:00.000Z';
      return route.fulfill(
        notificationsBody(
          [
            row(2, '2026-06-02T12:00:00.000Z'),
            row(1, '2026-06-01T12:00:00.000Z'),
          ],
          seen ? 0 : 2,
        ),
      );
    });
    await page.route('**/api/auth/signup', async (route) =>
      route.fulfill(signupOk()),
    );

    await page.goto('/en');
    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await expect(bell).toHaveAttribute(
      'aria-label',
      'Watch notifications, 0 unread',
    );

    await bell.click();
    await expect(page.getByText('No notifications yet.')).toBeVisible();
    await page.keyboard.press('Escape');

    // Two notifies land while closed (bot delivery, mocked): the mount
    // fetch after reload reports them without marking anything seen, so
    // the badge counts both.
    delivered = true;
    await page.reload();
    await expect(bell).toHaveAttribute(
      'aria-label',
      'Watch notifications, 2 unread',
    );
    await expect(bell.getByText('2')).toBeVisible();

    // Opening shows both newest-first with stable datetime attributes…
    await bell.click();
    const items = page.getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator('time')).toHaveAttribute(
      'datetime',
      '2026-06-02T12:00:00.000Z',
    );
    await expect(items.nth(1).locator('time')).toHaveAttribute(
      'datetime',
      '2026-06-01T12:00:00.000Z',
    );

    // …and marks everything visible as seen: badge gone…
    await expect(bell).toHaveAttribute(
      'aria-label',
      'Watch notifications, 0 unread',
    );

    // …and it stays gone across a reload (localStorage watermark; the
    // watermark-aware mock above answers the sinceSentAt fetch with 0).
    await page.reload();
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveAttribute('aria-label', 'Watch notifications, 0 unread');
  });

  test('logout from the dropdown returns to the sign-in link', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('active')),
    );
    await page.route('**/api/auth/signup', async (route) =>
      route.fulfill(signupOk()),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en');
    await avatarButton(page).click();
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });

    // Explicit logout: cookie destroyed server-side, reload lands on the
    // navbar sign-in link and the bell is gone.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('link', { name: 'Sign in', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveCount(0);
  });

  test('expired session mid-use shows the login gate inside the dropdown', async ({
    page,
  }) => {
    // The unit half lives in WatchManager.test.tsx; what E2E proves is the
    // wiring: a 401 from the lane surfaces the re-login link (preserving
    // the current page) instead of crashing the panel.
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill({ status: 401, body: 'nope' }),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en');
    await avatarButton(page).click();
    await expect(
      page.getByText('Steam login failed. Try again in a moment.'),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('link', { name: 'Sign in with Steam' }),
    ).toHaveAttribute('href', '/api/auth/steam/login?next=%2Fen%2F');
  });

  test('error states: failed signup, failed inbox with retry', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/auth/signup', async (route) =>
      route.fulfill({ status: 500, body: 'boom' }),
    );
    let inboxDown = true;
    let watchStatus = 'none';
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody(watchStatus)),
    );
    await page.route('**/api/watch/notifications*', async (route) => {
      if (inboxDown) {
        return route.fulfill({ status: 500, body: 'boom' });
      }
      return route.fulfill(
        notificationsBody([row(1, '2026-06-01T12:00:00.000Z')], 1),
      );
    });

    await page.goto('/en');
    await avatarButton(page).click();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({
      timeout: 15000,
    });

    // Server failure surfaces as a friendly error, not a crash — and the
    // not-watching screen stays (nothing was created server-side).
    await page.getByRole('button', { name: 'Watch this profile' }).click();
    await expect(
      page.getByText('Could not start watching. Try again in a moment.'),
    ).toBeVisible();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible();

    // Inbox failure shows error + retry; recovery renders the row.
    // (Reach the inbox with the lane flipped to active, as a returning
    // active user would load it.)
    watchStatus = 'active';
    await page.reload();
    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await expect(bell).toBeVisible({ timeout: 15000 });
    await bell.click();
    await expect(page.getByText('Could not load notifications.')).toBeVisible();

    inboxDown = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText('Could not load notifications.')).toHaveCount(
      0,
    );
  });

  test('a home search fires the analytics beacon (notify-hook trigger)', async ({
    page,
  }) => {
    // The notify enqueue itself runs server-side (mocked away, like every
    // other analytics write in this suite); what E2E can prove is that the
    // search flow actually emits the beacon that triggers it.
    const beacon = page.waitForRequest('**/api/recordAnalytics');
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible();

    await page.getByPlaceholder(/Search for a player/).fill('player-c');
    await page.getByRole('button', { name: /search/i }).click();
    await expect(page).toHaveURL(/\/en\/player\/player-c$/);

    const req = await beacon;
    expect(req.method()).toBe('POST');
  });

  test('chained journey: search fires the beacon, then the inbox shows the notify', async ({
    page,
  }) => {
    // One user journey across pages: a logged-in watcher searches, the
    // beacon fires (the server-side enqueue + bot delivery it triggers is
    // mocked away AND proven at the DAL/integration level — the `delivered`
    // flip below stands in for that pipeline, not for user behavior), then
    // the navbar inbox shows the notification.
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('active')),
    );
    let delivered = false;
    await page.route('**/api/watch/notifications*', async (route) => {
      if (!delivered) {
        return route.fulfill(notificationsBody([], 0));
      }
      return route.fulfill(
        notificationsBody([row(7, '2026-06-04T12:00:00.000Z')], 1),
      );
    });
    await page.route('**/api/auth/signup', async (route) =>
      route.fulfill(signupOk()),
    );

    // Act 1: search emits the beacon.
    const beacon = page.waitForRequest('**/api/recordAnalytics');
    await page.goto('/en');
    await expect(
      page.getByRole('heading', { name: /^SteamReveal$/ }),
    ).toBeVisible();
    await page.getByPlaceholder(/Search for a player/).fill('player-d');
    await page.getByRole('button', { name: /search/i }).click();
    await expect(page).toHaveURL(/\/en\/player\/player-d$/);
    await beacon;

    // Act 2 (server pipeline, simulated): the notify delivers…
    delivered = true;

    // Act 3: …and the inbox shows it.
    await page.goto('/en');
    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await expect(bell).toHaveAttribute(
      'aria-label',
      'Watch notifications, 1 unread',
    );
    await bell.click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('listitem').locator('time')).toHaveAttribute(
      'datetime',
      '2026-06-04T12:00:00.000Z',
    );
  });
});

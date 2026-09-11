import { test, expect, loginTestUser } from './support/fixtures';

// Full Watch flow E2E (Steam OpenID era) — NEVER touches Steam or a real
// database: watch endpoints are fulfilled at the network layer (the bot
// side stays covered by unit/integration tests), and authentication goes
// through the TEST-ONLY seam (`POST /api/auth/test-login`, mock-mode
// gated, real iron-session crypto on the real Next server). No localStorage
// identity exists anywhere in this flow.
// Server-side guarantees (cooldown windows, search_id idempotency,
// 24h rules) live in db.integration.test.ts; what THIS suite proves is
// the user-visible wiring: login gate → request → pending → active →
// bell → inbox, opt-out, unread persistence, and the error states.

const STEAM_ID = '76561198000000001';

const requestPending = (
  inviteQueued = true,
  pendingExpiresInMs: null | number = null,
) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    steamId: STEAM_ID,
    status: 'pending',
    inviteQueued,
    pendingExpiresInMs,
  }),
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

test.describe('Watch full flow (mocked bot, real session)', () => {
  test('logged-out visitor sees the Steam login gate, never a form', async ({
    page,
  }) => {
    await page.goto('/en/watch');

    const loginLink = page.getByRole('link', { name: 'Sign in with Steam' });
    await expect(loginLink).toBeVisible();
    await expect(loginLink).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2Fwatch',
    );
    // No text field, no bell, no notification traffic without a session.
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveCount(0);
  });

  test('login link hits the real OpenID handler (302 to Steam)', async ({
    page,
  }) => {
    await page.goto('/en/watch');

    const responsePromise = page.waitForResponse('**/api/auth/steam/login*');
    await page.getByRole('link', { name: 'Sign in with Steam' }).click();
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

  test('failed callback shows the login error state', async ({ page }) => {
    await page.goto('/en/watch?auth=error');

    // Scoped by text: the real ToastContainer also exposes role="alert".
    await expect(
      page.getByText('Steam login failed. Try again in a moment.'),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Sign in with Steam' }),
    ).toBeVisible();
  });

  test('request -> pending -> active -> bell appears without reload', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    // Creation is explicit: nothing posts until the Start button is hit.
    let requestCalls = 0;
    await page.route('**/api/watch/request', async (route) => {
      requestCalls += 1;
      return route.fulfill(requestPending());
    });
    // Pre-click polls all read 'none' (stable no-watch screen no matter how
    // many polls StrictMode double-mount fires); post-click polls walk
    // pending → pending → active and stick there.
    let requested = false;
    const postClick = ['pending', 'pending', 'active'];
    await page.route('**/api/watch/status', async (route) => {
      if (!requested) return route.fulfill(statusBody('none'));
      return route.fulfill(statusBody(postClick.shift() ?? 'active'));
    });
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({
      timeout: 15000,
    });
    expect(requestCalls).toBe(0);

    // The request fires on click with locale only — identity NEVER leaves
    // the session into the request body.
    const requestPromise = page.waitForRequest('**/api/watch/request');
    await page.getByRole('button', { name: 'Watch this profile' }).click();
    requested = true;
    const request = await requestPromise;
    expect(request.postDataJSON()).toEqual({ locale: 'en' });

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
  });

  test('opt-out sticks: status none never re-subscribes on revisit', async ({
    page,
  }) => {
    // Regression net for silent re-subscription: unfriend deletes the row
    // (reads as 'none'), and mounting /watch must NOT recreate it — every
    // visit would otherwise undo the opt-out while logged in.
    await loginTestUser(page, STEAM_ID);
    let requestCalls = 0;
    await page.route('**/api/watch/request', async (route) => {
      requestCalls += 1;
      return route.fulfill(requestPending());
    });
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('none')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({
      timeout: 15000,
    });
    await page.reload();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({
      timeout: 15000,
    });

    expect(requestCalls).toBe(0);
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
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill(requestPending()),
    );

    await page.goto('/en/watch');
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });

    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await bell.click();
    await expect(page.getByText('No notifications yet.')).toBeVisible();
    await expect(bell).toHaveAttribute(
      'aria-label',
      'Watch notifications, 0 unread',
    );
    await page.keyboard.press('Escape');

    // Two notifies land while closed (bot delivery, mocked): the mount
    // fetch after reload reports them without marking anything seen, so
    // the badge counts both.
    delivered = true;
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });
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
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveAttribute('aria-label', 'Watch notifications, 0 unread');
  });

  test('logout returns to the login gate; expired session shows it too', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    let status: string | number = 'active';
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(
        typeof status === 'number'
          ? { status, body: 'boom' }
          : statusBody(status),
      ),
    );
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill(requestPending()),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });

    // Explicit logout: cookie destroyed server-side, reload lands on login.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('link', { name: 'Sign in with Steam' }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveCount(0);

    // Session died mid-use (401 from the lane): same gate, no crash.
    await loginTestUser(page, STEAM_ID);
    status = 401;
    await page.goto('/en/watch');
    await expect(
      page.getByRole('link', { name: 'Sign in with Steam' }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('error states: failed request, failed inbox with retry', async ({
    page,
  }) => {
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/request', async (route) =>
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

    await page.goto('/en/watch');
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
    // (Reach the inbox by flipping the lane to active, as a returning
    // active user would load it.)
    watchStatus = 'active';
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });
    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await bell.click();
    await expect(page.getByText('Could not load notifications.')).toBeVisible();

    inboxDown = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText('Could not load notifications.')).toHaveCount(
      0,
    );
  });

  test('pending re-request inside the cooldown window stays pending (no error)', async ({
    page,
  }) => {
    // Server says: still pending, invite NOT re-queued (7-day window).
    // UI-visible half of the cooldown contract (the window math itself is
    // unit-tested at the DAL level): calm pending screen, no error.
    await loginTestUser(page, STEAM_ID);
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill(requestPending(false, 6 * 24 * 3600 * 1000)),
    );
    await page.route('**/api/watch/status', async (route) =>
      route.fulfill(statusBody('pending')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');

    await expect(
      page.getByRole('heading', { name: 'Invite sent' }),
    ).toBeVisible();
    await expect(
      page.getByText('Could not start watching. Try again in a moment.'),
    ).toHaveCount(0);
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
    // the watch hub shows the notification.
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
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill(requestPending()),
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
    await page.goto('/en/watch');
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible({
      timeout: 15000,
    });
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

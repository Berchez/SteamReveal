import { test, expect, seedWatchIdentity, submitWatchRequest } from './support/fixtures';
import { WATCH_IDENTITY_KEY } from '@/app/templates/Home/hooks/watch/watchIdentity';

// Full Watch flow E2E (WB-16) — NEVER touches Steam or a real database:
// every watch endpoint is fulfilled at the network layer, which also
// stands in for the bot side (activation, friend-remove, chat delivery
// are bot-process behaviors covered by unit/integration tests instead).
// Server-side guarantees (cooldown windows, search_id idempotency,
// 24h rules) live in db.integration.test.ts; what THIS suite proves is
// the user-visible wiring: request → pending → active → bell → inbox,
// opt-out, unread persistence, and the error states.

const STEAM_ID = '76561198000000001';

const requestPending = (inviteQueued = true, pendingExpiresInMs: null | number = null) => ({
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

const notificationsBody = (rows: Array<{ id: number; sentAt: string }>, unreadCount: number) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ steamId: STEAM_ID, notifications: rows, unreadCount }),
});

const row = (id: number, sentAt: string) => ({ id, sentAt });

test.describe('Watch full flow (mocked bot)', () => {
  test('request -> pending -> active -> bell appears without reload', async ({ page }) => {
    let statusCalls = 0;
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill(requestPending()),
    );
    await page.route('**/api/watch/status*', async (route) => {
      statusCalls += 1;
      // Activation lands on the 3rd poll (two pendings first): the UI must
      // ride pending → active with no user action in between.
      return route.fulfill(statusBody(statusCalls <= 2 ? 'pending' : 'active'));
    });
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');
    await expect(page.getByText('Watch a Steam profile')).toBeVisible();

    // No identity yet: no bell, no notification traffic at all.
    await expect(page.getByRole('button', { name: /Watch notifications/ })).toHaveCount(0);

    const requestPromise = page.waitForRequest('**/api/watch/request');
    await submitWatchRequest(page, STEAM_ID);
    const request = await requestPromise;
    expect(request.postDataJSON()).toMatchObject({ steamId: STEAM_ID, locale: 'en' });

    await expect(page.getByText('Invite sent')).toBeVisible();
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 20000 });

    // Same-tab broadcast (WATCH_IDENTITY_EVENT): the bell shows up with no F5.
    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('aria-label', 'Watch notifications, 0 unread');
  });

  test('empty inbox -> notifications arrive -> badge -> open clears -> reload persists', async ({
    page,
  }) => {
    // Returning-user shape: identity already stored (seeded pre-load; a
    // single goto, so the addInitScript re-seed caveat does not apply).
    await seedWatchIdentity(page, STEAM_ID);
    await page.route('**/api/watch/status*', async (route) =>
      route.fulfill(statusBody('active')),
    );
    let delivered = false;
    // Watermark-aware like the real route: once the client reports a
    // sinceSentAt at/after the newest delivery, the count drops to zero.
    await page.route('**/api/watch/notifications*', async (route) => {
      if (!delivered) {
        return route.fulfill(notificationsBody([], 0));
      }
      const since = new URL(route.request().url()).searchParams.get('sinceSentAt');
      const seen = since !== null && since >= '2026-06-02T12:00:00.000Z';
      return route.fulfill(
        notificationsBody(
          [row(2, '2026-06-02T12:00:00.000Z'), row(1, '2026-06-01T12:00:00.000Z')],
          seen ? 0 : 2,
        ),
      );
    });

    await page.goto('/en/watch');
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 15000 });

    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await bell.click();
    await expect(page.getByText('No notifications yet.')).toBeVisible();
    await expect(bell).toHaveAttribute('aria-label', 'Watch notifications, 0 unread');
    await page.keyboard.press('Escape');

    // Two notifies land while closed (bot delivery, mocked): the mount
    // fetch after reload reports them without marking anything seen, so
    // the badge counts both.
    delivered = true;
    await page.reload();
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 15000 });
    await expect(bell).toHaveAttribute('aria-label', 'Watch notifications, 2 unread');
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
    await expect(bell).toHaveAttribute('aria-label', 'Watch notifications, 0 unread');

    // …and it stays gone across a reload (localStorage watermark; the
    // watermark-aware mock above answers the sinceSentAt fetch with 0).
    await page.reload();
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveAttribute('aria-label', 'Watch notifications, 0 unread');
  });

  test('opt-out paths: forget-local hides the bell, status none heals to the form', async ({
    page,
  }) => {
    await seedWatchIdentity(page, STEAM_ID);
    let status: string = 'active';
    await page.route('**/api/watch/status*', async (route) =>
      route.fulfill(statusBody(status)),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toBeVisible();

    // Local opt-out: form returns, bell disappears, storage key gone.
    await page.getByRole('button', { name: 'Forget this browser' }).click();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Watch notifications/ }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        (key) => window.localStorage.getItem(key),
        WATCH_IDENTITY_KEY,
      ),
    ).toBeNull();

    // Friend-remove observed server-side (bot opt-out path): a stored
    // identity whose watch reads 'none' heals back to the form instead of
    // showing a stale screen forever.
    await seedWatchIdentity(page, STEAM_ID);
    status = 'none';
    await page.reload();
    await expect(page.getByText('Watch a Steam profile')).toBeVisible({ timeout: 15000 });
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      WATCH_IDENTITY_KEY,
    );
    expect(stored).toBeNull();
  });

  test('error states: invalid id, failed request, failed inbox with retry', async ({
    page,
  }) => {
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill({ status: 500, body: 'boom' }),
    );
    let inboxDown = true;
    await page.route('**/api/watch/status*', async (route) =>
      route.fulfill(statusBody('active')),
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

    // Client-side validation fires before any request.
    await page.getByPlaceholder('SteamID64 (17 digits)').fill('nope');
    await page.getByRole('button', { name: 'Watch this profile' }).click();
    await expect(page.getByText('Enter a valid 17-digit SteamID64.')).toBeVisible();

    // Server failure surfaces as a friendly error, not a crash.
    await submitWatchRequest(page, STEAM_ID);
    await expect(page.getByText('Could not start watching. Try again in a moment.')).toBeVisible();

    // Inbox failure shows error + retry; recovery renders the row.
    // (Reach the inbox by presetting a valid identity, as a returning user would have.)
    await seedWatchIdentity(page, STEAM_ID);
    await page.reload();
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 15000 });
    const bell = page.getByRole('button', { name: /Watch notifications/ });
    await bell.click();
    await expect(page.getByText('Could not load notifications.')).toBeVisible();

    inboxDown = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByText('Could not load notifications.')).toHaveCount(0);
  });

  test('pending re-request inside the cooldown window stays pending (no error)', async ({
    page,
  }) => {
    // Server says: still pending, invite NOT re-queued (7-day window).
    // UI-visible half of the cooldown contract (the window math itself is
    // unit-tested at the DAL level): calm pending screen, no error.
    await page.route('**/api/watch/request', async (route) =>
      route.fulfill(requestPending(false, 6 * 24 * 3600 * 1000)),
    );
    await page.route('**/api/watch/status*', async (route) =>
      route.fulfill(statusBody('pending')),
    );
    await page.route('**/api/watch/notifications*', async (route) =>
      route.fulfill(notificationsBody([], 0)),
    );

    await page.goto('/en/watch');
    await submitWatchRequest(page, STEAM_ID);

    await expect(page.getByText('Invite sent')).toBeVisible();
    await expect(page.getByText('Could not start watching. Try again in a moment.')).toHaveCount(0);
  });

  test('a home search fires the analytics beacon (notify-hook trigger)', async ({ page }) => {
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
    // One user journey across pages: a returning watcher searches, the
    // beacon fires (the server-side enqueue + bot delivery it triggers is
    // mocked away AND proven at the DAL/integration level — the `delivered`
    // flip below stands in for that pipeline, not for user behavior), then
    // the watch hub shows the notification.
    await seedWatchIdentity(page, STEAM_ID);
    await page.route('**/api/watch/status*', async (route) =>
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
    await expect(page.getByText('Watching')).toBeVisible({ timeout: 15000 });
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

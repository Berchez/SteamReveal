# Plan — Global navbar + bot-link confirmation

## 0. Locked decisions

- **OpenID kept** (proves identity) + **link click** (proves channel/activation, with immediate login).
- **`/watch` becomes a redirect to `/`**; flows live in the navbar + compact panel.
- **Avatar via Steam API** on every load, with fallback, logged-in only.
- **New `accounts` table** (no separate token table: nullable `confirm_token_hash`/`confirm_expires_at` columns).
- Link sequence: **site shows the step** (accept the invite → bot sends the link in chat → click confirms).

## 1. Current state (starting point)

- OpenID auth + `iron-session` implemented; self-scoped watch routes; `/watch` is a page with `WatchManager` + `WatchInbox`; identity via session (localStorage removed).
- Friendship stays a chat prerequisite (Steam limitation, no new deadlock: the invite goes out at signup, before the link).
- No navbar: `LanguageSwitcher` floats at `fixed top-4 right-4` inside `Home.tsx` (covers `/` and `/player`).

## 2. Persistence — migration `005_accounts.sql`

```sql
CREATE TABLE IF NOT EXISTS accounts (
  steam_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,              -- NULL = registered, link not yet clicked
  confirm_token_hash TEXT,        -- SHA-256 hex of the token, never plaintext
  confirm_expires_at TEXT,        -- ~24h; NULL when none outstanding
  locale TEXT
);
```

- Token: `crypto.randomBytes(32).hex()`; store `sha256(token)`; ~24h expiry; re-issuable.
- DAL (`src/lib/analytics/db.ts`, existing pattern): `createAccount` (INSERT OR IGNORE — idempotent), `getAccount`, `issueConfirmToken`, `consumeConfirmToken` (1 atomic UPDATE with predicate + `rowsAffected` check; hash comparison).
- Tests: mock (DAL) + real integration (concurrent double-consume → only 1 wins; expired rejects; post-consume reuse rejects).

## 3. Signup — `POST /api/auth/signup` (requires OpenID session)

- Reads `steamId` from the session (401 without); `locale` from the body.
- Creates `accounts` (unconfirmed) + `watched_profiles` pending + invite (reuses existing DAL); issues the token.
- Rate limit + Origin CSRF + 400/401/500 following the watch-route pattern. Unit tests mirroring `watch/request`.

## 4. Bot delivers the link (1 touchpoint)

- New env `WATCH_SITE_URL` (absolute base; dev and prod differ).
- In `index.ts`, on `onActivated`: `getAccount` → if `confirmed_at` is null, sends the confirmation message (`SITE_URL/api/watch/confirm?token=<hex>`) instead of the welcome; if confirmed, current welcome.
- New template in `notificationText.ts` (`confirmText(locale, url)`) in all 5 languages + tests.
- No new queue, no new lane, no cooldown/cap/TTL/opt-out changes.

## 5. Confirmation — `GET /api/watch/confirm?token=`

- Works **logged out**: validates hash + expiry + consumes in 1 atomic UPDATE → sets `confirmed_at` → **seals the session** (immediate login) → redirect `/` with success toast.
- Invalid/expired/used token → redirect `/` with friendly error.
- Rate limit. Tests: success, reuse, expired, invalid, no prior session with session created.

## 6. Global navbar — `SiteNav`

- New async Server Component in `[locale]/layout.tsx`: fixed top-right cluster with `LanguageSwitcher` (moved from `Home.tsx`), bell (`WatchInbox` with session steamId) and avatar/sign-in.
- Logged in: round 40px avatar (`getSteamAvatarUrl(steamId)` server-side via `steamapi`; letter/SVG fallback; API failure never breaks the page) + dropdown (watch status, panel link, sign out).
- Logged out: Steam button (login link with `next` = current page).
- No new polling, no new global state; SSR reads the session directly (no flash).

## 7. Dissolving `/watch`

- Route becomes a permanent `redirect('/')` (preserves bookmarks).
- `WatchManager` becomes the compact panel content (same pending/active/none states + explicit Start — no auto-POST, no post-opt-out re-subscribe).
- Delete the page's obsolete parts; update e2e tests that navigate to `/watch`.

## 8. i18n (5 locales, tested parity)

- New: signup/login button, steps ("accept the invite", "click the chat link"), confirmation success, expired-link error, avatar alt, dropdown status.
- Bot-link texts translated; nothing hardcoded.

## 9. Tests (DoD)

- Unit + integration (DAL, routes, libs, components).
- Full-journey E2E: signup → invite → mocked friendship → delivered link (test seam reads the pending token in `DEV_TEST_MODE`, same gate as `test-login`) → click → confirmed account + active session + bell.
- Gates: lint, `tsc --noEmit`, full Jest, full Playwright.

## 10. Docs and final validation

- `WATCH_BOT_RUNBOOK.md` (bot sends link, `WATCH_SITE_URL`, warm-up), `AGENTS.md` (new routes/tables), `WATCH_PROD_READINESS.md` (update sign-offs).
- Pre-merge checklist: no secret/plaintext token in log or response; real single-use token; expiry applied; old `/watch` redirecting; suite green end to end.

## 11. Execution order

1. Migration + DAL + tests → 2. signup + confirm + tests → 3. bot (template + branch + env) → 4. `SiteNav` + avatar + move switcher → 5. dissolve `/watch` + clean obsolete → 6. i18n ×5 + parity → 7. e2e + full validation + docs.

## 12. Amendment — click-to-activate (post-reported-bug)

 Behavior fix: befriending the bot NO LONGER activates the watch.
 Before, `activateWatch` fired on accept (reconcile) and the link was only
 a login bonus — the watch notified and the site toasted without a click. Now
 activation requires the click, and the plan above reads with these tweaks:

- **DAL gate**: `activateWatch` requires `confirmed_at` (carve-out: legacy
  rows without `accounts` activate as before — they consented under the old
  contract).
- **Friendship accept**: reconcile sends ONLY the link (new hook,
  without activating); confirmed ones activate + welcome as before. The hook
  emits ONLY the first time (no stored hash): never re-emits over an
  expired token — expired ones belong to the notice+resend flow, never to
  reconcile (otherwise the single notice would starve and the 1h throttle
  would be bypassed).
- **Click**: `GET /api/watch/confirm` became an intermediate page (immune to
  prefetch/linkifier/antivirus); `POST` consumes + activates + enqueues
  `welcome` + seals session. Origin CSRF like signup/logout. Post-review
  decision (auto-submit removed): the page loads NO <script> element —
  only the explicit button click confirms, so opening/previewing the URL
  never spends the token in any context (not even visible+focused headless).
- **Welcome**: `welcome` event delivered by the bot (the site can't reach
  chat). POST only enqueues when it activated itself (backstop activates via
  `onActivated` and gives its own welcome — no double).
- **Expiry (24h kept)**: no automatic resend. The bot poller sends
  ONE message ("link expired, generate another on the site") per token
  generation, with pre-send recheck + conditional write (concurrent click
  always wins). Marker `confirm_expire_noticed_for` (migration 008).
- **Generate new**: `POST /api/auth/confirm-resend` (session + CSRF +
  rate-limit) enqueues `confirm_resend`; the bot issues (sole issuer) with
  a 1h per-profile throttle; UI on expired pending (`confirmExpired` in the
  status + 3 i18n keys ×5 locales).
- **Backstop**: periodic reconcile (10min) converges activations whose click
  landed while the DB was down; `GET /api/watch/status` carries
  `confirmExpired` (degrades to false with logging, never 500s the poll).
- **No destructive migration**: only 008 (nullable column). **Never rename**
  an applied migration (007 incident: applied as 006, renamed, replay
  broke the migrate — see contract in `scripts/migrate-db.ts`).
- Coverage: gate + scan + marker in the DAL (mock + real libSQL), reconcile
  branches, activation split, route GET/POST, 3 pollers, resend
  route/UI, rewritten journey e2e (accept→pending without toast; POST→active;
  expired→resend). `useWatchStatus` unchanged (the toast now truly means
  "confirmed").

## 13. Amendment — single-state model (friendship-gated login)

 Switches the funnel for fresh logged-out users: **Sign in with Steam →
 waiting room → add the bot → login completes by itself → watch `active`
 directly** (no Start, no pending, no link; whoever adds the bot BEFORE
 skips the room). No more mandatory order. What changes and what does
 NOT change:

- **OpenID callback** (`callback/route.ts`): 3rd gate — `isBotFriend` via
  `GetFriendList` of the `STEAM_BOT_STEAMID` account (the bot's list must
  stay PUBLIC), 8s timeout. Already-friend completes immediately; `false`
  HOLDS the verified login in a sealed 30min pending and lands in the
  waiting room (`?login=waiting`, 10s poll on `GET /api/auth/steam/pending`
  that re-proves everything server-side and completes by itself — no second
  OpenID); `null`/bad env → `?auth=error` fail-closed, no session.
  Load-bearing order in `completeLogin.ts` (single implementation, used by
  both the callback AND the completion): `ensureActiveWatch` (fatal) →
  `recordLogin` (audit, non-fatal, migration 010) → `saveWatchSession` →
  welcome ONCE if activated (3 attempts, non-fatal) → (+ clears the pending
  in the pending route). Seal-before-welcome on purpose: a seal failure
  never leaves an orphaned welcome. `?watch=new` is the only "watch live"
  signal (no more pending for debuts).
- **Bot accepts inbound** (`bot.ts`): `RequestRecipient` → `addFriend`
  (live + offline-arrival sweep, sequential). LIMITED at the sink:
  `BOT_AUTO_ACCEPT_DAILY_LIMIT` (50/day UTC, only successes consume) +
  `BOT_AUTO_ACCEPT_FRIEND_CAP` (240 friends, headroom under Steam's 250
  cap) — refusal logs `REFUSED`/`sweep paused` (availability alert,
  runbook §5); exhaustion (attack or growth) defers new onboarding until
  intervention — the `ACQ_BOT_*` shard is the scale answer (backlog).
- **NOT dead**: `POST /api/auth/signup` + Start button + `invitePoller` +
  `GET/POST /api/watch/confirm` stay alive for **post-opt-out re-watch**
  (the cookie survives the unfriend: stale `none` → Start → pending →
  bot invite → link → click) and for legacy tokens. Fresh logged-out
  users never touch any of it. `activateWatch` keeps the `confirmed_at`
  gate for the link lane, and `ensureActiveWatch` mirrors the SAME
  predicate at login (turns `active` only with no `accounts` row
  — legacy carve-out — or with an already-confirmed account; pending +
  unconfirmed account stays pending until the click). Re-login never skips
  the click: §12 still holds on every lane (sign-off 8b).
- **Deferred-accept retry**: the inbound sweep (`acceptPendingRequests`)
  runs on `friendsList` AND on the reconcile timer (10min) — deferred
  cap/daily converge without reconnect (UTC day rollover, freed slots).
- **Login latency/quota** (accepted, monitor): +1 `GetFriendList` (8s
  cap) + 1-3 queries + audit per login; `STEAM_API_KEY`/`_2` quota
  shared with search (current mitigation: draw between the two keys).
  Measure p95/p99 post-deploy; no dedicated key for now.

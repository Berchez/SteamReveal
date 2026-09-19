# End-to-End Test Manual — feat/steam-profile-watch

Manual QA script for Watch with bot confirmation, covering the happy journey,
click-to-activate, expired link, generate-new-link, throttle, logout, opt-out,
bot offline, language matrix and security acceptance.

> Scope: observable behavior with real Steam accounts + DEV Turso database.
> 405/403/429 rate limits, race conditions, DB retries and long cooldown
> windows are covered by automated tests — see §14 and don't retest by hand
> (slow and inconclusive).

---

## 0. Prerequisites

| #   | Item               | Detail                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2 Steam accounts   | One for the **bot**, one for the **tester** (receives invite, reads chat). **Use only your own test accounts** — some cases validate deliberately accepted tradeoffs.                                                                                                                                                                                      |
| 2   | DEV Turso database | Create one just for this. **Never run these tests against production.**                                                                                                                                                                                                                                                                                   |
| 3   | Local `.env`       | `DATABASE_URL` + `DATABASE_TOKEN` (DEV); `SESSION_SECRET` with 32+ chars; `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`, `STEAM_BOT_SHARED_SECRET`; `WATCH_SITE_URL=http://localhost:3000`; `STEAM_API_KEY` (optional — without it the avatar falls back to a letter, the flow works). `DEV_TEST_MODE` **off/absent** (on enables mocked fixtures). |
| 4   | First time         | Interactive `pnpm run start:bot` and approve Steam Guard on the phone (see `WATCH_BOT_RUNBOOK.md` §3).                                                                                                                                                                                                                                                   |
| 5   | Migration          | `pnpm run db:migrate` → `✔ All migrations applied.` and `_migrations` contains `008_accounts_expire_notice.sql`.                                                                                                                                                                                                                                          |
| 6   | Boot everything    | Terminal 1: `pnpm run dev` (`:3000`). Terminal 2: `pnpm run start:bot`.                                                                                                                                                                                                                                                                                   |

### 0.1. Fast-forwarding time (required to test expiry without waiting 24h)

In `.env`, **before** starting the bot (TTL and scan are read by the bot only; the site reads
the database live and needs no restart):

```sh
BOT_CONFIRM_TOKEN_TTL_MS="120000"   # link expires in 2 min (default 24h)
BOT_EXPIRY_SCAN_INTERVAL_MS="60000" # expired scan every 1 min (default 1h)
```

To go back to normal, delete the lines and restart the bot.

### 0.2. The 4 observation surfaces (use all 4 in every case)

1. **Tester's Steam chat** — what the bot actually sent (exact text
   matters).
2. **Browser** — avatar dropdown (`none`/`pending`/`active`), toasts,
   bell/badge, inbox. DevTools → Application → Cookies →
   `steamreveal_watch_session` (present = logged in; absent = logged out).
3. **Database** (Turso dashboard or `turso db shell`):
   ```sql
   SELECT steam_id, confirmed_at, confirm_expires_at, locale FROM accounts WHERE steam_id='<ID64>';
   SELECT steam_id, status, locale FROM watched_profiles WHERE steam_id='<ID64>';
   SELECT id, kind, status, created_at, sent_at FROM watch_events WHERE steam_id='<ID64>' ORDER BY id DESC LIMIT 20;
   ```
4. **Bot logs** — `reconcile done (... linksSent=)`, `welcome poll done`,
   `resend poll done`, `expiry scan done`, `raced by a click`, `friend-remove`.
   Liveness: `pnpm run healthcheck:bot`.

### 0.3. Reset between cycles (always do it, unless "no reset" is explicit)

1. On the tester's Steam: **unfriend the bot** (removes
   `watched_profiles` + `accounts` atomically).
2. On the site: avatar → **Sign out** (kills the cookie).
3. Check the database: both `SELECT`s above come back empty.

---

## 1. Happy journey (foundation of everything)

> Two lanes (single-state login-first model): **(a) new lane** — logged-out
> user enters first and lands in the waiting room (`?login=waiting`, no
> error); adds the bot and the login completes by itself (`active`, no Start
> or link; see `WATCH_MANUAL_QA_CORE.md` QA-C01 for the short script — no
> mandatory order: whoever adds first skips the room); **(b)
> legacy/confirmation lane** — below (QA-01→QA-03), via Start with a session
> (post-opt-out re-watch with surviving cookie, or old tokens): Start
> → pending → bot invite → link → click. `invitePoller` stays active
> for lane (b); the bot also accepts inbound (lane (a)), bounded by
> `BOT_AUTO_ACCEPT_DAILY_LIMIT`/`BOT_AUTO_ACCEPT_FRIEND_CAP` (refusals log
> `REFUSED` — see runbook §5).

### QA-01 — Signup → invite → friendship → link (no activation!)

1. Clean browser: `http://localhost:3000/en` → shows **Sign in**, no
   bell/avatar.
2. **Sign in with Steam** → real login → back logged in (avatar shows).
   (Fresh account WITHOUT prior friendship lands in the `?login=waiting`
   room — for lane (b), use a re-watch session; lane (a) is in the core doc.)
3. Open the avatar → `Watch a Steam profile` + `Watch your profile`. Logout
   (Sign out) visible beside it.
4. Click `Watch your profile` → `Invite sent` heading.
5. Database: `watched_profiles.status='pending'`; `accounts.confirmed_at=NULL`.
6. On Steam: accept the friend request.
7. **Expected (the fixed bug): NOTHING activates.** No `Watch active!`
   toast, dropdown stays `Invite sent`, database stays `pending` +
   `confirmed_at=NULL`. Wait ~10s (2 polls of 5s) and reconfirm.
8. In chat: the message with the link arrives (confirmation template in your language).
9. Database: `confirm_token_hash` with 64 hex (**never the plain token**),
   `confirm_expires_at` ≈ now+TTL.

### QA-02 — Intermediate page (only the click confirms, GET never spends)

1. Open the chat link → `Confirm your Watch request` page with the site
   look (dark card, purple button) and a `Confirm and activate` button.
   **Nothing happens by itself**: open, reload, switch tabs and back —
   no click, no POST, token intact. Click the button → lands on
   `/en/?confirmed=ok`.
2. Turn the browser JS off and repeat: the same page/button work
   (no `<script>` element — only the inline `onsubmit` anti-double-click
   guard, inert without JS) and reloading (F5) 2x keeps everything —
   simulates preview/antivirus, which never execute anything.
3. Database (before any POST): `confirmed_at` NULL, `status` pending,
   hash unchanged.
4. Extra: `curl.exe -s "LINK" | Select-String "<form"` → the form exists and
   `Select-String "<script"` → **no `<script>` element** (proof that
   preview has nothing to execute).

### QA-03 — The click activates everything

1. On the QA-02 page, click `Confirm and activate`.
2. **Expected:** redirect `/en/?confirmed=ok` + toast
   `Watch confirmed! The bot will message you on Steam whenever your profile is searched.`
   (dismisses itself; reload doesn't repeat).
3. Database: `confirmed_at` filled + token zeroed; `status='active'` +
   `activated_at`; `kind='welcome'` event → `sent`.
4. In ~5s: toast
   `Watch active! The bot will message you on Steam when this profile is searched.` +
   dropdown becomes `Watching`.
5. In chat: `SteamReveal Watch is now active for your profile...`.
6. `steamreveal_watch_session` cookie present. Repeat the click in an incognito
   tab (no session): works and logs in **there** (logged-out design on purpose).

### QA-04 — Search generates notify → bell → inbox

1. With watch `active`, search the profile by **typing the URL directly** (not via the
   bot's link — link searches are suppressed by the anti-loop token).
2. In ~1 min (60s poll): chat message + bell with `1 unread` badge.
3. Open the bell: item listed, badge zeroes, reload stays zeroed.
4. Database: `kind='notify'` → `sent`; `last_notified_at` filled.
5. **Cooldown:** search again → **nothing for 24h** (1 notice/day cap). To
   retest without waiting:
   `UPDATE watched_profiles SET last_notified_at='2000-01-01T00:00:00.000Z' WHERE steam_id='<ID64>'`
   and search again.

### QA-05 — Logout in all 3 states

For `none` (reset without signup), `pending` (signup without click) and `active`: avatar
→ **Sign out** exists → click → back to `Sign in`, bell gone, cookie gone. (The
`none` state had no logout before this fix.)

### QA-06 — Opt-out + fresh re-signup

1. With everything active: on Steam, **unfriend** (repeat another cycle blocking
   instead of unfriending).
2. Database: **both rows are gone**. Dropdown back to `Watch a Steam profile`.
   Old bell history **stays** (event log survives by design);
   new searches don't notify.
3. Click `Watch your profile` → cycle restarts **unconfirmed** (new
   invite, new link — never reuses an old confirmation).

---

## 2. Click-gating (proof that friendship alone doesn't activate)

- **QA-07 — Accept without click.** Already covered in QA-01 step 7; to pin it:
  after accepting, search your own profile → **no message** (watch still
  `pending` → hook returns `not-active`).
- **QA-08 — Prefetch via curl.** With a live link:
  `curl.exe -s "LINK" | Select-String "<form"` → the form exists; repeat 3x;
  then complete QA-03 normally (proves GETs didn't spend the token).
- **QA-09 — POST without Origin.** `curl.exe -X POST "LINK"` (no Origin header) →
  `403`. With `Origin: http://localhost:3000` but no session and a valid token →
  consumes and activates (302 to `?confirmed=ok`), proving the logged-out design.

## 3. Expired link + generate new (fast-forwarded TTL from §0.1)

Do QA-01 up to the link and **don't click**.

### QA-10 — Expiry: one notice, exactly once, only if unclicked

1. Wait ~3 min (expiry + 1 scan).
2. **Expected in chat, exactly 1x**, in the signup language:
   - en:
     `Your confirm link expired. Open SteamReveal, sign in, and generate a new one from the Watch panel.`
   - pt:
     `Seu link de confirmação expirou. Abra o SteamReveal, entre com a Steam e gere um novo no painel do Watch.`
   - es/de/ru: texts in `getConfirmExpiredText`
     (`src/lib/watch/notificationText.ts`).
3. Wait +2 cycles: **no second message**. Database:
   `confirm_expire_noticed_for` = noticed expiry; status stays `pending`; log
   `expiry scan done: ... notified=1`.
4. Click the **dead** link: expired-variant page (`This link expired`, no
   form). Forcing the POST: `?confirmed=error` +
   `This confirmation link is invalid or expired...`.

### QA-11 — Negative proof (clicked-in-time never gets a notice)

New cycle, receive the link, **click ~30s before expiry** (complete QA-03).
Past the original expiry + 2 scans: **no "expired" message ever arrives**
(pre-send recheck + conditional write block it; logs show no `notified`
for this profile).

### QA-12 — Generate a new link via the site

1. Expired state (end of QA-10). Avatar → `Invite sent` now shows the
   expired block + `Generate new link`.
2. Click → `New link on its way — check your Steam chat.` (no signup
   fired).
3. Chat: fresh link. Database: new `confirm_expires_at` (the notice re-arms
   by itself, no extra write).
4. **Old** link → error. **New** link → activates (QA-03). Expired block
   leaves the dropdown.

### QA-13 — Throttle (button spam ≠ chat spam)

With an expired link, click `Generate new link` **5x fast**. **Expected:
exactly 1 chat message** (the rest land in `throttled`, 1h floor; logs
`reason=throttled`). Database: 1 `confirm_resend` event → `sent`, rest →
`dropped`.

### QA-14 — Expiry with no later action = intentional silence

New cycle: accept the friendship (link arrives), ignore the LINK until it
expires (notice arrives, QA-10) and then **do nothing else** — neither click
generate, nor unfriend. Wait 2 scan cycles. **Expected:**
no other message ever arrives (no automatic resend by product decision;
the bot only acts again on explicit request). Status stays `pending`,
database unchanged after the marker. The only exits from this state are
the "Generate new link" button (QA-12) or unfriending and restarting (QA-06).

### QA-43 — Rich inbox: per-session detail + monthly counter + cooldown-free split

1. With watch `active`, search your own profile (direct URL) and **open the
   cheater report** in that search; await the notify (~1 min).
2. Open the bell: the item shows the full text + link, and below the session
   line — search date + `Cheater report opened` (or the language equivalent).
   The `<time>` `datetime` is the search itself.
3. At the panel top, right side: the `{N} searches this month` badge
   (N ≥ 1). Repeat without opening the cheater report: the next item comes
   **without** the badge line. The bot chat, in contrast, carries only the
   short teaser + link (teaser vs. detail on purpose).
4. **Bot × inbox split (no cooldown in the inbox).** Search the profile again
   right away (< 24h after the notify): the chat does **not** get a second
   message (bot 24h cooldown), but the bell **lists the new search** and the
   monthly badge increments. That's the product decision: throttled delivery,
   unthrottled history.

## 4. Errors and edges

| ID    | Case                               | How to do it                                                                                                                                                      | Expected                                                                                                                           |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| QA-15 | Malformed token                    | `/api/watch/confirm?token=nope`                                                                                                                                   | Redirect `?confirmed=error`, zero token reads in the database                                                                      |
| QA-16 | Link with glued dot                | Paste the link + `.` at the end (Steam's linkifier does this)                                                                                                     | Page/form work with the clean token                                                                                                |
| QA-17 | Double click                       | Same link in 2 tabs, click both almost together                                                                                                                   | One turns `ok`, the other `error` (single-use: second `consume` finds zero rows)                                                   |
| QA-18 | Re-click days later                | Click an already-consumed link                                                                                                                                    | Page shows the form (no oracle), POST lands on `error`                                                                             |
| QA-19 | Hand-deleted row with live link    | Delete the `accounts` row with a pending token, click the link                                                                                                    | Error page, **no crash**; on the bot's next pass the legacy lane (no `accounts` row) activates directly + welcome — never stuck    |
| QA-20 | Logged-out signup                  | `POST /api/auth/signup` without cookie (curl/DevTools)                                                                                                            | `401`                                                                                                                              |
| QA-21 | Third-party watch impossible       | Logged in, DevTools: `fetch('/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({steamId:'<OTHER_ID>',locale:'en'})})` | `400` (identity from session only)                                                                                                 |
| QA-22 | Status with `?steamId=`            | Navigate `/api/watch/status?steamId=<ID>` logged in                                                                                                               | `400` (self-scoped)                                                                                                                |
| QA-23 | Resend with still-valid link       | Via DevTools, `POST /api/auth/confirm-resend` right after receiving the link                                                                                      | `200 {ok:true, queued:true}` but **no** new message (bot discards as throttled; check `dropped`)                                   |
| QA-23b | Resend with failed send           | Request a resend and drop the bot host's network for ~1min (the send hits the 30s watchdog); restore and wait 1-2 passes                                            | Log shows the send error; `confirm_token_hash` returns to NULL in the database (rollback); next pass re-issues and delivers (`sent`, no `throttled`); UI never sticks on "check your chat" without a button |
| QA-24 | Already-confirmed/rowless resend   | Same call with watch `active` or without `accounts`                                                                                                               | `200 {ok:true, queued:false}`, zero events created                                                                                 |
| QA-25 | Logged-out resend                  | POST without cookie                                                                                                                                               | `401`, zero events                                                                                                                 |

## 5. Sessions and logout

- **QA-26 — Two browsers.** Logged in on A and B: logout on A → B **stays
  logged in** (sessions are cookie-based, no server store for mass
  revocation).
- **QA-27 — Global kill-switch.** Swap `SESSION_SECRET`, restart the dev
  server → avatar gone in every browser (seal won't open) → logging in
  again works. It's the only "log out everyone".
- **QA-28 — Cookie.** After QA-03 the cookie exists (`HttpOnly`, 30 days);
  after logout, gone. Session never holds anything beyond
  `{steamId, expiresAt}`.

## 6. Opt-out, invite and bot offline

- **QA-29 — Unfriend while pending.** Signup → **before** accepting,
  unfriend/cancel the invite → rows removed → can request again immediately
  (no 7-day lock in this case).
- **QA-30 — Silent re-friending.** After opt-out, re-add the bot on Steam
  **without** clicking Start → total silence (no row, no welcome, no
  watch). Only Start recreates.
- **QA-31 — Ignoring the invite.** Signup → never accept → silence forever
  (no token issued, no chat channel, expiry scan ignores —
  `confirm_expires_at` NULL).
- **QA-32 — Restart doesn't duplicate the link.** With a live pending link,
  restart the bot 2x → **still 1 message** in chat (live-token dedupe on
  the boot pass).
- **QA-33 — Click with bot offline.** Stop the bot, click the link → activates
  normally (site+DB suffice: toast, session, `active`). Start the bot →
  welcome arrives via outbox. Proves the decoupling.
- **QA-34 — Search with bot offline.** Stop the bot, search the active
  profile, start the bot → notify delivered on return (`queued` queue
  drains on boot).
- **QA-35 — Expired with bot offline.** Expiry happens with the bot stopped
  → on start, the notice arrives on the first pass (scan catch-up).
- **QA-36 — Double-Start.** Fast double-click on `Watch your profile` →
  **1** invite (invite discipline; check 1 open `invite` event in the
  database).
- **QA-37 — Re-request after 7 days.** With `pending` + ignored invite:
  `UPDATE watched_profiles SET requested_at='<7+ days ago>'` → Start → a
  new invite is sent (refresh + re-enqueue). Without the SQL, this case is
  automated-only.

## 7. Language matrix

Repeat QA-01→QA-03 with resets between rows, switching in the
`LanguageSwitcher`: link message, confirmation page, welcome, expiry notice
and resend UI. Minimum `en` + `pt`; ideal all 5 (`es`, `de`, `ru` — texts in
`CONFIRM_PAGE_TEXT` in the route, `notificationText.ts` and `messages/*.json`,
parity enforced by `watchLocales.test.ts`). **Deliberate trap:** signup in
pt + browser in en → the confirmation page renders in **pt** (follows the
stored language, not the browser's).

## 8. Accepted security (validate understanding, not "failure")

- **QA-38 — Forwarded link (only between your own accounts!).** Send the link
  to your 2nd account and click from it: whoever clicks **first** confirms+logs
  in as the owner and kills the link; the second sees an error. It's the
  documented login-by-link tradeoff.
- **QA-39 — Prefetch doesn't activate.** `curl.exe` 5x on the live link →
  then the browser click works normally (proof of effect-free GET; covers
  Steam preview/antivirus).
- **QA-40 — POST without Origin.** `curl.exe -X POST "LINK"` → `403` (CSRF
  fail-closed; the legitimate form always sends same-origin Origin).

## 9. Avatar dropdown: prefetch + skeleton (anti-CLS)

Precondition: logged in (avatar visible), DevTools open (Network tab +
Performance → Experience). Valid in any state (`none`/`pending`/`active`).

- **QA-41 — Opening without layout jump (SSR-seed + skeleton).** Reload
  the page and open the dropdown **without hovering first** (Tab to the
  avatar + Enter, or direct tap on mobile). Expected: the panel already
  opens with real content (server seed, no flash) — or, if the server read
  failed, with a pulsing **textless** placeholder that barely moves when
  content arrives. In the Performance recording (Slow 4G), **no**
  relevant `LayoutShift` event appears on open (the skeleton `min-h` was
  measured per locale; `ru`/`de` in the `none` state may shift ~40–70px
  down on the seedless path — accepted residual, documented in the
  `WatchManagerSkeleton.tsx` header).
- **QA-42 — Hover warms the panel (opens with content).** Hover the
  avatar ~1s and only then click: the panel must open **straight into real
  content**, with no skeleton flash. In the Network tab: one `GET
  /api/watch/status` on hover + one on open (mount revalidation — normal,
  cheap and idempotent). Repeating hover/click in sequence doesn't multiply
  requests (single-flight + 15s TTL) and quickly closing/reopening during a
  `pending → active` activation plays the `Watch active!` toast **exactly
  1x**.

## 10. Automated map (don't retest by hand)

| Case                                                                                                           | Suite                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate (friendship without click never activates; confirmed activates; legacy activates) in real SQL             | `db.test.ts` + `db.integration.test.ts`                                                                                                                                                   |
| Reconcile branch (confirmed→activate+welcome; unconfirmed→link only; isolated failure)                         | `reconcile.test.ts`                                                                                                                                                                       |
| Send split (dedupe, race, no undue welcome)                                                                    | `activationMessage.test.ts`                                                                                                                                                               |
| GET never consumes/activates; POST consumes+activates+welcome+session; 403/405/429; seal-failure→ok            | `confirm/route.test.ts`                                                                                                                                                                   |
| Pollers (send, drops, retry-to-cap, throttle, anti-nag recheck, overlap, offline-skip)                         | `welcomePoller` + `confirmExpiryPoller` + `confirmResendPoller` .test.ts                                                                                                                  |
| Resend route (401/403/405/429, queued true/false, loud 500) + `confirmExpired` status (4 states + degradation) | `confirm-resend/route.test.ts`, `status/route.test.ts`                                                                                                                                    |
| Resend UI, logout in all 3 states, hook, i18n ×5 parity                                                        | `WatchManager.test.tsx`, `useWatchStatus.test.ts`, `watchLocales.test.ts`                                                                                                                     |
| Rich inbox (per-session detail, cheater badge, monthly counter, bot teaser)                                     | `WatchInbox.test.tsx`, `notifications/route.test.ts`, `db.test.ts`, `db.integration.test.ts`, `notificationText.test.ts`, `notifyMessage.test.ts`, `e2e/watch.spec.ts` (chained journey) |
| Mocked journey (accept→pending without toast; POST→active; expired→resend)                                     | `e2e/watch.spec.ts` (3 new tests)                                                                                                                                                         |
| Fatal bot identity mismatch (stop + onFatal + no reconnect + stopped-deaf handlers) + unwired-exit warning     | `bot.test.ts`                                                                                                                                                                             |
| Undelivered-token rollback + guarded first-issue (`clearConfirmToken`, `issueConfirmTokenIfAbsent`)            | `activationMessage.test.ts`, `confirmResendPoller.test.ts`, `db.test.ts`, `db.integration.test.ts`                                                                                        |
| Session kind discriminator (no mass logout, cross-cookie replay refused)                                       | `session.test.ts`, `pendingLogin.test.ts`                                                                                                                                                 |
| Steam avatar CDN allowlist guard                                                                                | `next.config.test.ts`                                                                                                                                                                     |
| Commands                                                                                                       | `pnpm test` · `pnpm test -- --runTestsByPath <file>` · `pnpm run lint` · `pnpm exec tsc --noEmit` · `pnpm exec playwright test e2e/watch.spec.ts --project=chromium` · `pnpm run db:smoke` |

## 11. Final acceptance checklist

- [ ] QA-01→QA-06 green (happy, 3-state logout, opt-out + re-signup)
- [ ] QA-41→QA-42 green (no-jump skeleton on cold open; hover opens with content, 1 toast)
- [ ] QA-07→QA-09: gating proven (friendship without click = pending; GETs don't
      spend; click activates everything)
- [ ] QA-10: 1x expiry notice with the exact language text; QA-11:
      clicked-in-time never gets a notice
- [ ] QA-12→QA-14: generate-new works; throttle = 1 message; late accept
      self-heals
- [ ] QA-15→QA-25 no surprises (especially QA-17 single-use and QA-38 tradeoff)
- [ ] QA-26→QA-40 covered or consciously skipped
- [ ] QA-43 green (per-session detail + cheater badge + monthly badge; chat teaser only)
- [ ] §7 in at least en+pt (ideal 5)
- [ ] Database matches at every transition (§0.2, SQLs)
- [ ] `pnpm run lint`, `tsc`, `pnpm test`, e2e watch green
- [ ] QA `.env` with no committed secrets; nothing tested against production

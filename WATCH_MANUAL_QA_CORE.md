# QA Core — Watch happy path (bot on a limited account)

Short version of `WATCH_MANUAL_QA.md`: just the happy core
(login → wait → friendship → notify → inbox → opt-out), plus the legacy lane
(Start → link → click) for post-opt-out re-watch.
Edge cases, expiry, throttling, errors, i18n and security stay in the
full doc — see "Out of scope" at the end.

> Single-state login-first model: a fresh logged-out user NEVER presses
> Start and needs NO order — **enter first, the waiting room holds the
> verified login and completes by itself when the friendship appears**
> (whoever adds the bot first skips the room). The
> Start→pending→link→click lane stays alive only for post-opt-out
> re-watch (the cookie survives the unfriend) and for legacy tokens —
> QA-C02/C03 cover that lane.

> Scope: observable behavior with real Steam accounts + DEV Turso
> database. **Never run against production.**

---

## 0. Prerequisites

| #   | Item              | Detail                                                                                                                                                                                                                     |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2 Steam accounts  | **Bot** (may be **limited**: no US$5 spend — it never needs to *send* invites in this script, only receive/accept and chat) + **FULL tester** (must *send* the friend request to the bot). Use your own accounts only. |
| 2   | DEV Turso database | Create one just for this. **Never against production.**                                                                                                                                                                    |
| 3   | Local `.env`      | `DATABASE_URL` + `DATABASE_TOKEN` (DEV); `SESSION_SECRET` with 32+ chars; `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`, `STEAM_BOT_SHARED_SECRET`; `WATCH_SITE_URL=http://localhost:3000`; `STEAM_API_KEY` optional (without it the avatar falls back to a letter, the flow works). `DEV_TEST_MODE` **off/absent**. |
| 4   | First time        | Interactive `pnpm run start:bot` and approve Steam Guard on the phone (see `WATCH_BOT_RUNBOOK.md` §3). Note the **bot's profile/ID64** — the tester will add it directly via URL (limited accounts may not show up in friend search). |
| 5   | Migration         | `pnpm run db:migrate` → `✔ All migrations applied.`                                                                                                                                                                         |
| 6   | Boot everything   | Terminal 1: `pnpm run dev` (`:3000`). Terminal 2: `pnpm run start:bot`.                                                                                                                                                      |

No TTL fast-forward (only useful for expiry tests, out of this script).

### 0.1. Friendship direction (read before starting)

A limited account does **not send** invites, but **accepts** received ones — and
in the single-state model the direction is exactly that: **the tester adds
the bot** (inbound request), the bot accepts by itself via `addFriend` (daily
limit 50 + 240 friends cap — see runbook §5), and the login proves the
friendship. No bot invite is needed on the new lane.

**Path A — with the bot running (start here):**

1. On the **tester's** Steam, open the **bot's profile via direct URL** and
   send the friend request.
2. Wait ~1 min: the bot log shows `accepted inbound friend request
   (... friends=... acceptedToday=...)`. Confirm the friendship on both accounts.
3. Log in on the site (QA-C01 below) — lands `active` directly.

**Path B — deterministic fallback (if A doesn't converge in ~3 min):**

1. **Stop the bot** (`Ctrl+C`).
2. On the **bot's** account (Steam client or mobile), **manually accept** the
   tester's pending request.
3. **Start the bot** again and log in — the gate reads the friendship via
   `GetFriendList` and activates directly.

**Expected noise (not a bug):** if the bot hits the cap/daily budget, logs
show `friend-accept REFUSED` / `sweep paused` — in that case the request stays
pending for the next sweep/day, not lost. With default `.env`
(240/50) this only happens under burst — never in normal QA.

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
   `friend-remove`. Liveness: `pnpm run healthcheck:bot`.

### 0.3. Reset between cycles (always do it)

1. On the tester's Steam: **unfriend the bot** (removes
   `watched_profiles` + `accounts` atomically).
2. On the site: avatar → **Sign out** (kills the cookie).
3. Check the database: both `SELECT`s above come back empty.

---

## 1. QA-C01 — Login → wait → friendship → active by itself (new lane, no Start)

1. Clean browser: `http://localhost:3000/en` → shows ONLY **Sign in**
   (no separate chip), no bell/avatar.
2. **Sign in with Steam** (tester account) WITHOUT having added the bot →
   back at `/en/?login=waiting` with the **"Finish signing in"** room (no
   error, no session yet: no avatar, no `steamreveal_watch_session`
   cookie). Proves the login holds instead of denying.
3. **Add the bot** on the tester's Steam (room button, profile in a new
   tab, §0.1) and await the `accepted inbound friend request` in the log.
4. Without clicking anything else: in ~10s the room completes by itself →
   `?watch=new` landing + `Watch active! ...` toast (dismisses itself;
   reload doesn't repeat) and the avatar appears.
5. Open the avatar → `Watching` heading (never `Invite sent` — there was
   no Start). Database: `watched_profiles.status='active'` + `activated_at`;
   `accounts.last_login_at` filled.
6. `steamreveal_watch_session` cookie present.
7. **Reload mid-wait:** reload `/en/?login=waiting` before adding
   the bot → the room comes back and keeps waiting (the pending
   survives reload); the poll continues without duplicating anything.

## 2. QA-C02 — Confirmation page, legacy lane (only the click confirms)

> Legacy lane / re-watch: after QA-C06 (opt-out) KEEP the cookie
> (don't Sign out) — the surviving session shows `Watch a Steam
> profile` + Start, and this lane lives there. On a fresh logged-out
> account this lane is unreachable (login already activates directly).

1. In the dropdown, click `Watch your profile` → `Invite sent` heading
   (database: `pending`).
2. On Steam, accept the bot's invite → the link arrives in chat
   (confirmation template in your language). Database:
   `confirm_token_hash` with 64 hex (**never the plain token**),
   `confirm_expires_at` ≈ now+24h.
3. Open the link → `Confirm your Watch request` page with the
   `Confirm and activate` button. **Nothing happens by itself**: open,
   reload, switch tabs and back — no click, no POST, token intact.
4. Turn JS off and repeat on a fresh cycle: the same page/button
   work (no `<script>` element — only the inline `onsubmit`
   anti-double-click guard, inert without JS) and reloading (F5) 2x spends
   nothing.
5. Database (before any POST): `confirmed_at` NULL, `status` pending,
   hash unchanged.

## 3. QA-C03 — The click activates everything (legacy lane)

1. On the QA-C02 page, click `Confirm and activate`.
2. **Expected:** redirect `/en/?confirmed=ok` + toast
   `Watch confirmed! You will be notified here whenever your profile is searched.`
   (dismisses itself; reload doesn't repeat).
3. Database: `confirmed_at` filled + token zeroed; `status='active'` +
   `activated_at`; `kind='welcome'` event → `sent`.
4. In ~5s: toast
   `Watch active! The bot will message you on Steam when this profile is searched.` +
   dropdown becomes `Watching` (same 5s status poll as QA-03 — the ~20s figure
   belongs to the chat welcome delivery via the 20s welcome poller, step 5).
5. In chat: `SteamReveal Watch is now active for your profile...`.
6. `steamreveal_watch_session` cookie present.

## 4. QA-C04 — Search generates notify → bell → inbox

1. With watch `active`, search the profile by **typing the URL directly**
   (not via the bot's link — link searches are suppressed by the anti-loop
   token).
2. In ~1 min (60s poll): chat message + bell with `1 unread` badge.
3. Open the bell: item listed, badge zeroes, reload stays zeroed.
4. Database: `kind='notify'` → `sent`; `last_notified_at` filled.
5. **Optional (costs 1 extra search):** repeat the search and **open the
   cheater report** in it → the new bell item shows the session line with
   the search date + `Cheater report opened` (or the language equivalent).
6. **Cooldown (read-only):** search again → **nothing for 24h** (1
   notice/day cap; the throttle-free bell lists normally). To retest
   without waiting:
   `UPDATE watched_profiles SET last_notified_at='2000-01-01T00:00:00.000Z' WHERE steam_id='<ID64>'`.

## 5. QA-C05 — Quick logout

For `none`, `pending` and `active`: avatar → **Sign out** → back to `Sign
in`, bell gone, cookie gone.

## 6. QA-C06 — Opt-out + fresh re-signup

1. With everything active: on the tester's Steam, **unfriend the bot**.
2. Database: **both rows are gone**. Dropdown back to
   `Watch a Steam profile`. New searches don't notify.
3. Without signing out (surviving session): click `Watch your profile`
   → legacy cycle restarts **unconfirmed** (QA-C02/C03: new invite,
   Steam accept, new link, click). Alternative: Sign out → add
   the bot again (§0.1) → Sign in → new lane activates directly (QA-C01).

---

## Final acceptance checklist (core)

- [ ] QA-C01 green (no friendship → `?login=waiting` room without error; add the bot → completes by itself + `watch=new` toast, no Start, no second login)
- [ ] QA-C02 green (legacy lane: only the click confirms; without JS the form survives reloads)
- [ ] QA-C03 green (`confirmed_at` + `active` + chat welcome + toast)
- [ ] QA-C04 green (chat notify + bell item + zeroed badge; cooldown on the bot only)
- [ ] QA-C05 green (logout in all 3 states)
- [ ] QA-C06 green (opt-out wipes the rows; re-watch via Start with surviving session OR via new lane with re-login)
- [ ] Database matches at every transition (§0.2, SQLs)

## Out of scope (in the full `WATCH_MANUAL_QA.md` doc)

- Expiry/notice/resend/throttle (QA-10→QA-14) — requires fast-forwarded TTL (§0.1 there)
- Error and edge matrix (QA-15→QA-25), advanced sessions/logout (QA-26→QA-28)
- Bot offline, re-friending, double-start, 7 days (QA-29→QA-37)
- Language matrix §7 (minimum en+pt when covering)
- Accepted security §8 (forwarded link, prefetch, POST without Origin)
- Dropdown skeleton/prefetch §9 (QA-41→QA-42)
- Automated map §10 (what Jest/Playwright already cover — don't retest by hand)

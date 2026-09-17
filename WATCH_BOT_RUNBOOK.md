# Watch Bot Runbook (WB-17)

Operations guide for the SteamReveal Watch Bot (`src/bot-steam/`). The bot is a
long-lived process holding ONE Steam session: it reconciles friendships, sends
friend invites (WB-7), delivers notify chat messages (WB-13), sends welcome
messages on activation (WB-11), and handles opt-out unfriends (WB-8). It
reads/writes the same Turso database as the site (`watch_events`,
`watched_profiles`) — no separate datastore.

> Never commit secrets. `STEAM_BOT_PASSWORD` / `STEAM_BOT_SHARED_SECRET` bypass
> Steam Guard permanently — a leak is account takeover. They live ONLY in the
> process environment (local `.env`, never committed) and never appear in logs
> (unit-tested in `src/bot-steam/bot.test.ts`).

- Setup: [1. Prerequisites](#1-prerequisites) ·
  [2. Environment variables](#2-environment-variables) ·
  [3. First login](#3-first-login-steam-guard-approval)
- Operation: [4. Start / restart / stop](#4-start--restart--stop) ·
  [5. Healthcheck / monitoring](#5-healthcheck--monitoring) ·
  [6. Behavior when the bot is offline](#6-behavior-when-the-bot-is-offline)
- Incidents:
  [7. If the bot account is banned / flagged](#7-if-the-bot-account-is-banned--flagged)
  · [8. Credential rotation](#8-credential-rotation-no-ban) ·
  [9. Security notes](#9-security-notes)

## 1. Prerequisites

- Node + pnpm (same toolchain as the repo; `pnpm install` first).
- A **dedicated Steam account** for the bot (never a personal account). Steam
  "limited" accounts cannot send friend invites until ~US$5 has been spent
  directly through Steam — budget that spend before going live.
- A mobile-authenticator secret for that account (`STEAM_BOT_SHARED_SECRET`):
  the `shared_secret` field from a Steam Desktop Authenticator (SDA) maFile, or
  equivalent TOTP secret. The bot derives fresh TOTP codes at every logon via
  `steam-totp` (steam-user 5.3.0).
- `DATABASE_URL` (+ `DATABASE_TOKEN` for remote Turso URLs): the SAME analytics
  database the site writes. The bot only touches `watched_profiles` /
  `watch_events`.
- Accurate server clock (TOTP codes are time-based; >30s skew fails logon).

## 2. Environment variables

Required (bot exits 1 on startup without them):

| Var                       | Meaning                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `STEAM_BOT_USERNAME`      | Bot's Steam login name                                                                 |
| `STEAM_BOT_PASSWORD`      | Bot's Steam password                                                                   |
| `STEAM_BOT_SHARED_SECRET` | TOTP shared secret (see above)                                                         |
| `DATABASE_URL`            | Turso DB (same as the site)                                                            |
| `DATABASE_TOKEN`          | Turso token (remote URLs only)                                                         |
| `WATCH_SITE_URL`          | Public site base URL, no trailing slash (bot-delivered confirm links point here — wrong env = dead links; tokens only exist in one DB) |
| `SESSION_SECRET`          | Login-cookie seal (32+ chars, one per environment — site only, the bot never reads it) |

Optional (degraded gracefully when absent):

| Var              | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `STEAM_API_KEY`  | Same Steam Web API key as the site — used ONLY to resolve the watched nickname for notify text. Without it notifies still send, naming the SteamID64 URL instead of `(Nick)`. |
| `STEAM_API_KEY_2`| Ignored by the bot (no failover here — one lookup per notify is cheap).                          |

Optional tuning (defaults shown — the full list with the abuse-math rationale
lives in `.env.example` under "Watch Bot"):

| Var                                              | Default                     | Meaning                                          |
| ------------------------------------------------ | --------------------------- | ------------------------------------------------ |
| `BOT_AUTO_ACCEPT_DAILY_LIMIT`                    | `50`                        | Max INBOUND friend-request accepts per UTC day (Sybil bound at the sink — mirrors the invite cap; only successful accepts burn budget) |
| `BOT_AUTO_ACCEPT_FRIEND_CAP`                     | `240`                       | Safety ceiling: refuse auto-accepts once FRIEND entries reach this many (headroom under Steam's default 250 cap; hitting it logs `REFUSED` loudly — operator-action incident) |
| `BOT_DATA_DIR`                                   | `.data/steam-bot`           | Session/sentry persistence (gitignored)          |
| `BOT_HEARTBEAT_PATH`                             | `<data dir>/heartbeat.json` | Liveness file                                    |
| `BOT_HEARTBEAT_INTERVAL_MS`                      | `60000`                     | Heartbeat write cadence                          |
| `BOT_HEARTBEAT_STALE_MS`                         | `180000`                    | Healthcheck staleness threshold                  |
| `BOT_RECONNECT_BASE_MS` / `BOT_RECONNECT_MAX_MS` | `1000` / `60000`            | Capped exponential backoff                       |
| `BOT_INVITE_POLL_INTERVAL_MS`                    | `60000`                     | Invite drain cadence                             |
| `BOT_INVITE_BATCH_LIMIT`                         | `5`                         | Max invites claimed per pass                     |
| `BOT_INVITE_DAILY_LIMIT`                         | `50`                        | GLOBAL real-invite cap per UTC day (abuse bound) |
| `BOT_INVITE_MAX_ATTEMPTS`                        | `3`                         | Attempts before an invite is dropped             |
| `BOT_INVITE_SEND_TIMEOUT_MS`                     | `30000`                     | Per-invite watchdog                              |
| `BOT_NOTIFY_POLL_INTERVAL_MS`                    | `60000`                     | Notify drain cadence                             |
| `BOT_NOTIFY_BATCH_LIMIT`                         | `10`                        | Max notifies claimed per pass                    |
| `BOT_NOTIFY_MAX_ATTEMPTS`                        | `3`                         | Attempts before a notify is dropped              |
| `BOT_NOTIFY_SEND_TIMEOUT_MS`                     | `30000`                     | Per-message watchdog                             |
| `BOT_NOTIFY_TTL_DAYS`                            | `7`                       | Events older than this are dropped unsent        |
| `BOT_CONFIRM_TOKEN_TTL_MS`                       | `86400000` (24h)          | Signup-confirm link lifetime (bot-issued tokens expire after this) |
| `BOT_WELCOME_POLL_INTERVAL_MS`                   | `20000`                     | Post-click welcome drain cadence (faster: reacts to a live user click) |
| `BOT_WELCOME_BATCH_LIMIT`                        | `10`                        | Max welcomes claimed per pass                      |
| `BOT_WELCOME_MAX_ATTEMPTS`                       | `3`                         | Attempts before a welcome is dropped               |
| `BOT_WELCOME_SEND_TIMEOUT_MS`                    | `30000`                     | Per-message watchdog                               |
| `BOT_RESEND_POLL_INTERVAL_MS`                    | `60000`                     | Confirm-link resend drain cadence (user-awaited)   |
| `BOT_RESEND_BATCH_LIMIT`                         | `10`                        | Max resends claimed per pass                       |
| `BOT_RESEND_MAX_ATTEMPTS`                        | `3`                         | Attempts before a resend is dropped                |
| `BOT_RESEND_SEND_TIMEOUT_MS`                     | `30000`                     | Per-message watchdog                               |
| `BOT_RESEND_MIN_INTERVAL_MS`                     | `3600000` (1h)              | Min gap between two issues for one profile (spam bound) |
| `BOT_EXPIRY_SCAN_INTERVAL_MS`                    | `3600000` (1h)              | Expired-link notice scan cadence (one notice per generation) |
| `BOT_RECONCILE_INTERVAL_MS`                      | `600000` (10min)            | Periodic full reconcile (backstop for missed snapshots) |
| `BOT_STALE_SWEEP_INTERVAL_MS`                    | `600000`                  | Orphaned-claim recovery cadence                  |
| `BOT_STALE_CLAIM_WINDOW_MINUTES`                 | `30`                        | Claims older than this get requeued              |

Shell/CI exports win over `.env` (shared `loadEnv()` semantics — same as every
script in this repo).

## 3. First login (Steam Guard approval)

First logon from a new IP almost always needs a **manual Steam Guard approval**:

1. Fill in the five required vars (Section 2).
2. Run interactively and watch the logs: `pnpm run start:bot`
3. Approve the sign-in from the Steam mobile app (or enter the emailed code flow
   if prompted — the bot logs what it is waiting on).
4. Success looks like `[WatchBot] logged on to Steam` followed by a reconcile
   summary line. The session (sentry/machine-id) persists under `BOT_DATA_DIR`,
   so subsequent restarts skip approval.
5. If logon loops with auth failures: check password, check server clock (TOTP),
   and if you recently changed the password, stop the bot, point `BOT_DATA_DIR`
   at a fresh empty directory, and start over (stale sentry after a credential
   change is the usual culprit).

## 4. Start / restart / stop

- Start (foreground): `pnpm run start:bot`
- Run it under a supervisor in production (systemd, pm2, tmux — anything that
  restarts on exit), e.g. a unit whose `ExecStart` is the command above with the
  env file loaded. Single instance only: two bots on one account kick each other
  off Steam.
- Stop gracefully with SIGINT/SIGTERM: the bot stops timers, calls `logOff`, and
  exits ~500ms later so the socket write flushes. Never SIGKILL except as a last
  resort (a killed mid-send worker leaves a `claimed` row for the stale sweep to
  recover — safe, just delayed).
- Restart is always safe: pollers resume from the DB queues, reconcile
  re-converges on (re)logon, and the daily invite count is DB-backed (survives
  restarts instead of resetting "since boot").

## 5. Healthcheck / monitoring

- Liveness file: `BOT_HEARTBEAT_PATH` (default
  `.data/steam-bot/heartbeat.json`), rewritten every
  `BOT_HEARTBEAT_INTERVAL_MS`. It carries `connected`, `steamId`, `uptimeSec`.
- Turso heartbeat mirror (site-side gate): on the SAME cadence the bot upserts
  the same facts into the single-row `bot_heartbeat` table (migration `011`).
  The Vercel site cannot read the local file across hosts, so the navbar hides
  the sign-in button while the bot cannot promise a login based on THIS table
  (see `src/lib/watch/botLiveness.ts`) — two offline causes: a stale beat
  (process down ≥ ~4 min) or a sustained `connected=0` streak (≥ ~5 min per
  the SQL-maintained `disconnected_since` column — a banned/flagged account
  or a never-approved Guard keeps beating fresh, and this is what catches
  it). Transient reconnects (backoff cap 60s) never reach the window. The
  write is best-effort: a DB blip never crashes the bot — it only degrades
  to "site assumes online" until the next successful write.
- Check: `pnpm run healthcheck:bot` — exit `0` fresh, `1` missing-or-stale
  (older than `BOT_HEARTBEAT_STALE_MS`), `2` misconfigured threshold.
- Wire it to whatever watches the box (cron every minute, uptime monitor,
  supervisor `ExecStartPost`): alert on non-zero exit. A stale heartbeat with
  the process alive usually means the Steam session died and the reconnect loop
  is backing off — check the logs before restarting.
- Friend-cap alert (Steam list is finite — default 250, higher for leveled
  accounts): alert on ANY `friend-accept REFUSED` or `sweep paused` line, and
  watch the `friends=` gauge on the accept lines as it approaches
  `BOT_AUTO_ACCEPT_FRIEND_CAP` (default 240). A capped bot defers ALL new
  Watch onboarding (the site login gate needs a free friend slot), so this is
  a product-availability incident, not bot noise. Response: check for Sybil
  (burst of throwaway accept lines), prune dead friends by hand in the Steam
  client if legitimate growth caused it, and plan the second-bot shard
  (own `ACQ_BOT_*` namespace — friendship with any other bot must never
  satisfy the login gate, see `config.ts`).
- Durability split for the auto-accept ceilings (explicit, not a bug): the
  DAILY budget (`BOT_AUTO_ACCEPT_DAILY_LIMIT`) is IN-MEMORY per process — a
  restart/deploy resets the day's tally, so frequent restarts within one UTC
  day each reopen the full budget (unlike the DB-backed outbound invite
  count, which survives restarts). Accepted: restarts are operator-driven,
  never attacker-triggerable, and the FRIEND CAP reads live Steam state on
  every decision — it is the restart-proof hard backstop. Deferred requests
  are retried by the 10-minute reconcile timer (UTC-day rollover and freed
  slots converge without waiting for a reconnect).
- Useful log greps: `accepted inbound friend request` (per-accept, carries
  `friends=` + `acceptedToday=` — the friend-count gauge for the Steam cap),
  `friend-accept REFUSED` (safety ceiling hit: friend cap or daily budget —
  operator-action incident, new onboarding is deferred, investigate the
  request source for Sybil), `pending-accept sweep paused` (offline-arrival
  backlog deferred to a later sweep, same incident class),
  `STEAM_BOT_STEAMID mismatch` (this process logged in as a different
  account than configured — EVERY login is gated on the configured id, so
  treat as a login outage until the envs agree on both sides),
  `turso heartbeat write failed` (liveness bridge down — the site falls back
  to "bot assumed online", so investigate but it does not crash anything),
  `invite poll done` (per-pass claimed/sent/retried/ dropped),
  `daily send cap reached` (abuse cap engaging — investigate the request
  source), `dropped after` (events hitting the attempt cap),
  `invite dropped:` (already-friends drops — benign, no attempt burned),
  `reconcile done` (now also `linksSent=` for confirm-link deliveries),
  `welcome poll done`, `resend poll done`, `expiry scan done`,
  `raced by a click` (harmless: the user confirmed between the expiry
  recheck and the mark), `friend-remove`.

## 6. Behavior when the bot is offline

Everything degrades to "queued, delivered later" — nothing is lost by a restart
alone:

- **Invites**: `watch_events(kind='invite', status='queued')` wait. On (re)logon
  the bot fires an immediate first pass, then the interval. Pending watch rows
  stay valid for the 7-day re-request window; the 50/day global cap still
  applies on drain (a long outage does NOT burst on return — at most 5/min,
  50/day with the defaults from Section 2; if those envs were tuned in
  production, the tuned numbers govern).
- **Notifies**: queued rows wait, EXCEPT rows older than `BOT_NOTIFY_TTL_DAYS`
  (default 7), which are dropped unsent on the next pass — by design, so a bot
  offline for days never wakes up to a week of stale pings.
- **Welcomes / resends**: queued rows wait (welcomes have no TTL — they state
  durable status, so late delivery stays correct). Expired confirm links are
  noticed on return (the hourly expiry scan catches up on boot): at most one
  "generate a new one" message per dead token generation.
- **Click-to-activate note**: friendship alone never activates — only the
  confirm-link click (POST) flips `pending` → `active`. A click that lands
  while the DB blips still confirms (token spent) and converges on the next
  reconcile pass (periodic, `BOT_RECONCILE_INTERVAL_MS`), without another
  click; the welcome follows via the outbox.
- **Orphaned `claimed` rows** (crash between claim and settle): the stale sweep
  requeues them after `BOT_STALE_CLAIM_WINDOW_MINUTES` (default 30).
  At-least-once semantics: a message sent but unmarked before the crash MAY
  deliver twice; chat messages are idempotent-ish and the 24h send-time cooldown
  suppresses rapid repeats. Known sharp edge (accepted, not fixed): if the send
  SUCCEEDS but the `markEventSent` bookkeeping fails 3x in a row, the row sits
  `claimed` (never requeued via attempts), the sweep requeues it ~30min later,
  and the next pass RE-SENDS — while `last_notified_at` was never written, so
  even the send-time cooldown does not catch that specific duplicate. Rare
  (triple write failure glued to a successful send) and self-limiting (one extra
  message, then the clock advances normally); duplicating is preferred over
  silently losing a core-product notification.
- **Friendships changed while offline**: the reconcile pass on every (re)logon
  converges them (activations + deactivations), same DAL calls as the live
  listeners — no duplicated logic, no missed opt-outs.

## 7. If the bot account is banned / flagged

Symptoms: logon rejected (`InvalidPassword`/banned EResult), invites or messages
failing 100% with Steam-side errors, or a Valve notice on the account. The
site self-protects on its own: once the sustained disconnect passes ~5 min
the navbar hides the sign-in button (fresh users are not stranded in the
waiting room), and it returns automatically as soon as the NEW bot logs on —
no site change needed during the swap. Plan B:

1. Stop the bot (`SIGTERM`; confirm exit).
2. Create a FRESH dedicated Steam account (never reuse a flagged one) and
   complete the ~US$5 direct spend so it can send friend invites (the
   re-watch lane still uses outbound invites).
3. Set up a new mobile authenticator; take the new `shared_secret`.
4. Update `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`, `STEAM_BOT_SHARED_SECRET`
   AND `STEAM_BOT_STEAMID` (the new account's 17-digit ID) in the environment —
   on the bot host AND on Vercel (the site's login gate reads the same var;
   a drifted Vercel value denies every login, and the bot logs
   `STEAM_BOT_STEAMID mismatch` LOUDLY on every logon while drifted — grep
   for it first if logins break after a swap).
5. Point `BOT_DATA_DIR` at a fresh empty directory (never reuse sentry files
   across accounts).
6. Start the bot and do the Section 3 first-login approval.
7. No DB migration is needed: watches live in the shared Turso DB. BUT the
   single-state model makes a swap bigger than it used to be — expect ALL of
   this, not just new invites:
   - Every login now gates on friendship with the NEW id, so ALL existing
     users (active included) must add the new bot and log in again — until
     they do, their logins HOLD in the waiting room (`?login=waiting`, no
     denial). That room is swap-safe by construction: its add-bot link is
     env-driven, so post-swap it points at the NEW bot, and completing
     from it re-inserts the watch as fresh-active (self-heal, no link
     needed) — but only if the user actually opens it and clicks through;
     silence from the user still reads as churn, so announce anyway.
   - The new bot starts with an EMPTY friends list, so its first reconcile
     DEACTIVATES every still-`active` watch whose user hasn't re-added yet
     (active + not-a-friend of the new bot reads as opt-out — same DAL call
     as an unfriend, no duplicated logic). This is correct per policy (the
     new bot cannot message non-friends), but it means the swap visibly
     resets the whole base: users come back via add-bot → login → active
     directly (no link needed on the fresh lane), NOT via the old
     invite-accept path.
   - Support blip is proportional to the whole active base ("who is this new
     bot? why did my watch stop?"), larger than the old pending-only blip.
     Announce the new profile URL ahead of the swap if possible.

## 8. Credential rotation (no ban)

- **Password change**: update `STEAM_BOT_PASSWORD`, restart. If logon loops
  afterwards, fresh `BOT_DATA_DIR` (Section 3.5).
- **Shared-secret re-issue** (leak suspected): update `STEAM_BOT_SHARED_SECRET`,
  restart. Treat any secret that touched a log, a screenshot, or a commit as
  burned — rotate immediately; there is no "probably fine".
- **DB token rotation**: update `DATABASE_TOKEN`, restart bot and redeploy the
  site env together (both sides share it).
- **`SESSION_SECRET` rotation** (site login cookie seal): generate a fresh 32+
  char value
  (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`),
  set it in the site env, redeploy. Effect is immediate and safe: every existing
  login cookie fails decryption on next read, so all users simply land back on
  the Steam login button — no data loss (watches live in the DB, not the
  cookie), no bot restart needed (the bot process never reads this secret).

## 9. Security notes

- The bot opens NO inbound ports: outbound Steam + Turso connections only.
- `.data/` (session, sentry, heartbeat) is gitignored — never commit it, never
  copy it to another machine together with secrets.
- `watch_events` rows carry only public SteamIDs + timestamps. The inbox and
  status APIs are self-scoped via the Steam OpenID session (each user reads only
  their own history) — see the route comments.
- Flow verification without Steam:
  `pnpm exec playwright test e2e/watch.spec.ts --project=chromium` drives
  request → pending → active → inbox → opt-out against fully mocked routes
  (unit/integration suites cover the DAL and bot logic with Steam 100% mocked).

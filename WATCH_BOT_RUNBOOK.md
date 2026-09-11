# Watch Bot Runbook (WB-17)

Operations guide for the SteamReveal Watch Bot (`src/bot-steam/`). The bot is
a long-lived process holding ONE Steam session: it reconciles friendships,
sends friend invites (WB-7), delivers notify chat messages (WB-13), sends
welcome messages on activation (WB-11), and handles opt-out unfriends (WB-8).
It reads/writes the same Turso database as the site (`watch_events`,
`watched_profiles`) — no separate datastore.

> Never commit secrets. `STEAM_BOT_PASSWORD` / `STEAM_BOT_SHARED_SECRET`
> bypass Steam Guard permanently — a leak is account takeover. They live
> ONLY in the process environment (local `.env`, never committed) and never
> appear in logs (unit-tested in `src/bot-steam/bot.test.ts`).

- Setup: [1. Prerequisites](#1-prerequisites) · [2. Environment variables](#2-environment-variables) · [3. First login](#3-first-login-steam-guard-approval)
- Operation: [4. Start / restart / stop](#4-start--restart--stop) · [5. Healthcheck / monitoring](#5-healthcheck--monitoring) · [6. Behavior when the bot is offline](#6-behavior-when-the-bot-is-offline)
- Incidents: [7. If the bot account is banned / flagged](#7-if-the-bot-account-is-banned--flagged) · [8. Credential rotation](#8-credential-rotation-no-ban) · [9. Security notes](#9-security-notes)

## 1. Prerequisites

- Node + pnpm (same toolchain as the repo; `pnpm install` first).
- A **dedicated Steam account** for the bot (never a personal account).
  Steam "limited" accounts cannot send friend invites until ~US$5 has been
  spent directly through Steam — budget that spend before going live.
- A mobile-authenticator secret for that account (`STEAM_BOT_SHARED_SECRET`):
  the `shared_secret` field from a Steam Desktop Authenticator (SDA) maFile,
  or equivalent TOTP secret. The bot derives fresh TOTP codes at every
  logon via `steam-totp` (steam-user 5.3.0).
- `DATABASE_URL` (+ `DATABASE_TOKEN` for remote Turso URLs): the SAME
  analytics database the site writes. The bot only touches
  `watched_profiles` / `watch_events`.
- Accurate server clock (TOTP codes are time-based; >30s skew fails logon).

## 2. Environment variables

Required (bot exits 1 on startup without them):

| Var | Meaning |
| --- | --- |
| `STEAM_BOT_USERNAME` | Bot's Steam login name |
| `STEAM_BOT_PASSWORD` | Bot's Steam password |
| `STEAM_BOT_SHARED_SECRET` | TOTP shared secret (see above) |
| `DATABASE_URL` | Turso DB (same as the site) |
| `DATABASE_TOKEN` | Turso token (remote URLs only) |

Optional tuning (defaults shown — the full list with the abuse-math
rationale lives in `.env.example` under "Watch Bot"):

| Var | Default | Meaning |
| --- | --- | --- |
| `BOT_DATA_DIR` | `.data/steam-bot` | Session/sentry persistence (gitignored) |
| `BOT_HEARTBEAT_PATH` | `<data dir>/heartbeat.json` | Liveness file |
| `BOT_HEARTBEAT_INTERVAL_MS` | `60000` | Heartbeat write cadence |
| `BOT_HEARTBEAT_STALE_MS` | `180000` | Healthcheck staleness threshold |
| `BOT_RECONNECT_BASE_MS` / `BOT_RECONNECT_MAX_MS` | `1000` / `60000` | Capped exponential backoff |
| `BOT_INVITE_POLL_INTERVAL_MS` | `60000` | Invite drain cadence |
| `BOT_INVITE_BATCH_LIMIT` | `5` | Max invites claimed per pass |
| `BOT_INVITE_DAILY_LIMIT` | `50` | GLOBAL real-invite cap per UTC day (abuse bound) |
| `BOT_INVITE_MAX_ATTEMPTS` | `3` | Attempts before an invite is dropped |
| `BOT_INVITE_SEND_TIMEOUT_MS` | `30000` | Per-invite watchdog |
| `BOT_NOTIFY_POLL_INTERVAL_MS` | `60000` | Notify drain cadence |
| `BOT_NOTIFY_BATCH_LIMIT` | `10` | Max notifies claimed per pass |
| `BOT_NOTIFY_MAX_ATTEMPTS` | `3` | Attempts before a notify is dropped |
| `BOT_NOTIFY_SEND_TIMEOUT_MS` | `30000` | Per-message watchdog |
| `BOT_NOTIFY_TTL_DAYS` | `7` | Events older than this are dropped unsent |
| `BOT_STALE_SWEEP_INTERVAL_MS` | `600000` | Orphaned-claim recovery cadence |
| `BOT_STALE_CLAIM_WINDOW_MINUTES` | `30` | Claims older than this get requeued |

Shell/CI exports win over `.env` (shared `loadEnv()` semantics — same as
every script in this repo).

## 3. First login (Steam Guard approval)

First logon from a new IP almost always needs a **manual Steam Guard
approval**:

1. Fill in the five required vars (Section 2).
2. Run interactively and watch the logs:
   `pnpm run start:bot`
3. Approve the sign-in from the Steam mobile app (or enter the emailed
   code flow if prompted — the bot logs what it is waiting on).
4. Success looks like `[WatchBot] logged on to Steam` followed by a
   reconcile summary line. The session (sentry/machine-id) persists under
   `BOT_DATA_DIR`, so subsequent restarts skip approval.
5. If logon loops with auth failures: check password, check server clock
   (TOTP), and if you recently changed the password, stop the bot, point
   `BOT_DATA_DIR` at a fresh empty directory, and start over (stale sentry
   after a credential change is the usual culprit).

## 4. Start / restart / stop

- Start (foreground): `pnpm run start:bot`
- Run it under a supervisor in production (systemd, pm2, tmux — anything
  that restarts on exit), e.g. a unit whose `ExecStart` is the command
  above with the env file loaded. Single instance only: two bots on one
  account kick each other off Steam.
- Stop gracefully with SIGINT/SIGTERM: the bot stops timers, calls
  `logOff`, and exits ~500ms later so the socket write flushes. Never
  SIGKILL except as a last resort (a killed mid-send worker leaves a
  `claimed` row for the stale sweep to recover — safe, just delayed).
- Restart is always safe: pollers resume from the DB queues, reconcile
  re-converges on (re)logon, and the daily invite count is DB-backed
  (survives restarts instead of resetting "since boot").

## 5. Healthcheck / monitoring

- Liveness file: `BOT_HEARTBEAT_PATH` (default
  `.data/steam-bot/heartbeat.json`), rewritten every
  `BOT_HEARTBEAT_INTERVAL_MS`. It carries `connected`, `steamId`,
  `uptimeSec`.
- Check: `pnpm run healthcheck:bot` — exit `0` fresh, `1` missing-or-stale
  (older than `BOT_HEARTBEAT_STALE_MS`), `2` misconfigured threshold.
- Wire it to whatever watches the box (cron every minute, uptime monitor,
  supervisor `ExecStartPost`): alert on non-zero exit. A stale heartbeat
  with the process alive usually means the Steam session died and the
  reconnect loop is backing off — check the logs before restarting.
- Useful log greps: `invite poll done` (per-pass claimed/sent/retried/
  dropped), `daily send cap reached` (abuse cap engaging — investigate the
  request source), `dropped after` (events hitting the attempt cap),
  `reconcile done`, `friend-remove`.

## 6. Behavior when the bot is offline

Everything degrades to "queued, delivered later" — nothing is lost by a
restart alone:

- **Invites**: `watch_events(kind='invite', status='queued')` wait. On
  (re)logon the bot fires an immediate first pass, then the interval.
  Pending watch rows stay valid for the 7-day re-request window; the
  50/day global cap still applies on drain (a long outage does NOT burst
  on return — at most 5/min, 50/day with the defaults from Section 2; if
  those envs were tuned in production, the tuned numbers govern).
- **Notifies**: queued rows wait, EXCEPT rows older than `BOT_NOTIFY_TTL_DAYS`
  (default 7), which are dropped unsent on the next pass — by design, so a
  bot offline for days never wakes up to a week of stale pings.
- **Orphaned `claimed` rows** (crash between claim and settle): the stale
  sweep requeues them after `BOT_STALE_CLAIM_WINDOW_MINUTES` (default 30).
  At-least-once semantics: a message sent but unmarked before the crash
  MAY deliver twice; chat messages are idempotent-ish and the 24h
  send-time cooldown suppresses rapid repeats. Known sharp edge (accepted,
  not fixed): if the send SUCCEEDS but the `markEventSent` bookkeeping
  fails 3x in a row, the row sits `claimed` (never requeued via attempts),
  the sweep requeues it ~30min later, and the next pass RE-SENDS — while
  `last_notified_at` was never written, so even the send-time cooldown
  does not catch that specific duplicate. Rare (triple write failure
  glued to a successful send) and self-limiting (one extra message, then
  the clock advances normally); duplicating is preferred over silently
  losing a core-product notification.
- **Friendships changed while offline**: the reconcile pass on every
  (re)logon converges them (activations + deactivations), same DAL calls
  as the live listeners — no duplicated logic, no missed opt-outs.

## 7. If the bot account is banned / flagged

Symptoms: logon rejected (`InvalidPassword`/banned EResult), invites or
messages failing 100% with Steam-side errors, or a Valve notice on the
account. Plan B:

1. Stop the bot (`SIGTERM`; confirm exit).
2. Create a FRESH dedicated Steam account (never reuse a flagged one) and
   complete the ~US$5 direct spend so it can send friend invites.
3. Set up a new mobile authenticator; take the new `shared_secret`.
4. Update `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`,
   `STEAM_BOT_SHARED_SECRET` in the environment.
5. Point `BOT_DATA_DIR` at a fresh empty directory (never reuse sentry
   files across accounts).
6. Start the bot and do the Section 3 first-login approval.
7. No DB migration is needed: watches live in the shared Turso DB and keep
   working. Users must accept ONE new friend invite (from the new account)
   — pending watches re-activate on acceptance exactly like before. Expect
   a support blip ("who is this new bot?") proportional to active watches.

## 8. Credential rotation (no ban)

- **Password change**: update `STEAM_BOT_PASSWORD`, restart. If logon loops
  afterwards, fresh `BOT_DATA_DIR` (Section 3.5).
- **Shared-secret re-issue** (leak suspected): update
  `STEAM_BOT_SHARED_SECRET`, restart. Treat any secret that touched a log,
  a screenshot, or a commit as burned — rotate immediately; there is no
  "probably fine".
- **DB token rotation**: update `DATABASE_TOKEN`, restart bot and redeploy
  the site env together (both sides share it).

## 9. Security notes

- The bot opens NO inbound ports: outbound Steam + Turso connections only.
- `.data/` (session, sentry, heartbeat) is gitignored — never commit it,
  never copy it to another machine together with secrets.
- `watch_events` rows carry only public SteamIDs + timestamps; the inbox
  API exposes the same. No login exists by product design (accepting the
  bot invite IS the opt-in proof) — see the route comments for the
  accepted-exposure rationale.
- Flow verification without Steam: `pnpm exec playwright test
  e2e/watch.spec.ts --project=chromium` drives request → pending → active
  → inbox → opt-out against fully mocked routes (unit/integration suites
  cover the DAL and bot logic with Steam 100% mocked).

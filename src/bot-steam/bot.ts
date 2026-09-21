/**
 * Watch Bot Steam client wrapper (WB-3).
 *
 * Owns exactly one thing: a logged-on Steam session with reconnects.
 * Everything product-shaped (reconcile on snapshot, heartbeat, chat) lives
 * outside and plugs in via callbacks — this class never touches the DAL,
 * the filesystem, or process signals (index.ts owns those), which is what
 * makes it unit-testable with a fake client.
 *
 * Reconnect policy: manual capped exponential backoff (base x2, capped at
 * max), attempt counter reset on every successful logon. steam-user's own
 * autoRelogin is deliberately LEFT OFF so there is exactly one reconnect
 * loop (this one) instead of two racing each other.
 */
import SteamUser from 'steam-user';
import { generateAuthCode } from 'steam-totp';

import type { WatchBotLogger } from './logger';

export interface BotSnapshotListener {
  (friendsById: Record<string, number>): void;
}

/**
 * Default safety ceiling for inbound auto-accepts: Steam caps a default
 * account at 250 friends (higher for leveled accounts). Refusing new
 * accepts at 240 keeps headroom for in-flight invites/hand-edits and turns
 * a full list into a loud log line instead of silent Steam rejections —
 * without this, anyone can fill the bot's list with throwaway accounts and
 * block every new Watch onboarding (the login gate needs a free slot).
 * Tunable via BOT_AUTO_ACCEPT_FRIEND_CAP (mirrored in config.ts).
 */
export const DEFAULT_AUTO_ACCEPT_FRIEND_CAP = 240;

/**
 * Default per-UTC-day budget for inbound auto-accepts. Mirrors the outbound
 * invite discipline (BOT_INVITE_DAILY_LIMIT=50): without a sink-side rate,
 * a Sybil burst fills the list in minutes; with it, exhaustion takes days
 * under normal ops — time for the friend-count alert below to fire and an
 * operator to intervene. Tunable via BOT_AUTO_ACCEPT_DAILY_LIMIT.
 *
 * DELIBERATELY in-memory (not DB-backed like the outbound invite count):
 * a restart/deploy resets the day's tally. Accepted because restarts are
 * operator-driven (not attacker-triggerable), so the bound still throttles
 * bursts to 50 per process lifetime per day — and the FRIEND CAP above
 * (Steam-side truth, restart-proof) is the hard backstop either way.
 */
export const DEFAULT_AUTO_ACCEPT_DAILY_LIMIT = 50;

export interface WatchBotOptions {
  client: SteamUser;
  accountName: string;
  password: string;
  sharedSecret: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /**
   * Safety ceiling / daily budget for inbound auto-accepts (see the
   * defaults above). index.ts wires these from the bot config; tests pass
   * small values to pin the guards deterministically.
   */
  autoAcceptFriendCap?: number;
  autoAcceptDailyLimit?: number;
  /** Injectable clock for the UTC-day rollover (tests only). */
  nowMs?: () => number;
  /**
   * The SteamID64 this process is SUPPOSED to be logged in as (same value
   * as STEAM_BOT_STEAMID — the site's login gate checks friendship against
   * that list). Verified against the live session on every logon: a typo,
   * a Vercel/bot-host env drift, or a reused BOT_DATA_DIR from another
   * account would otherwise go unnoticed — and a wrong-account bot is not
   * "degraded", it is DESTRUCTIVE: its friendsList snapshot describes the
   * wrong account, so the next reconcile pass reads every active watch
   * whose user is not a friend of the wrong account as an opt-out and
   * DELETES the whole base (removeWatchAndAccount, same DAL as a genuine
   * unfriend). Mismatches are therefore FATAL, not advisory: the bot
   * stops itself (logOff, no reconnect) and invokes onFatal, which the
   * host wires to a process exit — the supervisor restart becomes a loud
   * crash-loop, the heartbeat goes stale (healthcheck:bot alerts, the
   * site's liveness gate hides sign-in), and no destructive pass ever
   * runs. Unreadable session ids stay silent (nothing to compare yet,
   * not evidence of drift). index.ts wires this from the bot config.
   */
  expectedBotSteamId?: string;
  /**
   * Fatal-condition hook (currently only the identity mismatch above):
   * invoked AFTER the bot already stopped itself (containment is not the
   * host's job — stop() runs unconditionally so even an unwired host
   * cannot keep a wrong-account session up). The host owns the process
   * lifetime (exit code, supervisor alerting); exceptions are contained
   * and logged by the bot.
   */
  onFatal?: (reason: string) => void;
  onFriendsSnapshot?: BotSnapshotListener;
  /**
   * Fired with the affected steamId when the bot observes a friendship
   * REMOVAL (unfriend or block — see the friendRelationship subscription
   * below). index.ts routes this to the WB-8 opt-out handler. Non-removal
   * relationship changes never reach this callback. Never called with
   * secrets; exceptions are contained and logged.
   */
  onFriendRemoved?: (steamId: string) => void;
  /**
   * Fired on every successful (re)logon, after setPersona. Lets the host
   * trigger connection-gated work immediately (e.g. the first invite poll)
   * instead of waiting for the next interval tick. Never called with
   * secrets; exceptions are contained and logged.
   */
  onConnected?: () => void;
  logger?: WatchBotLogger;
  /** Injected for tests (avoids real TOTP computation). */
  generateTwoFactorCode?: (sharedSecret: string) => string;
}

/** Human-readable EResult for logs (numeric fallback when unknown). */
const describeEResult = (eresult: number | undefined): string => {
  if (typeof eresult !== 'number') return 'unknown';
  const name =
    (SteamUser.EResult as unknown as Record<number, string>)[eresult] ?? null;
  return name === null ? `EResult(${eresult})` : `${name}(${eresult})`;
};

export class WatchBot {
  private readonly client: SteamUser;

  private readonly accountName: string;

  private readonly password: string;

  private readonly sharedSecret: string;

  private readonly reconnectBaseMs: number;

  private readonly reconnectMaxMs: number;

  private readonly onFriendsSnapshot?: BotSnapshotListener;

  private readonly onFriendRemoved?: (steamId: string) => void;

  private readonly onConnected?: () => void;

  private readonly logger: WatchBotLogger;

  private readonly generateTwoFactorCode: (sharedSecret: string) => string;

  private readonly autoAcceptFriendCap: number;

  private readonly autoAcceptDailyLimit: number;

  private readonly nowMs: () => number;

  private autoAcceptDay: string | null = null;

  private autoAcceptsToday = 0;

  /**
   * steamIds with an addFriend currently awaiting Steam (live event vs
   * sweep race guard): a second path seeing the same id while the first is
   * still in flight skips it instead of burning a second daily-budget unit
   * for one accept — the request stays pending server-side either way, so
   * skipping is always safe (the owner's pass converges it).
   */
  private readonly acceptInFlight = new Set<string>();

  /** True while a sweep pass is awaiting Steam (timer-overlap guard). */
  private sweepInFlight = false;

  private readonly expectedBotSteamId: string | null;

  private readonly onFatal: ((reason: string) => void) | null;

  private stopped = false;

  private connected = false;

  private reconnectAttempts = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private listenersAttached = false;

  constructor(options: WatchBotOptions) {
    this.client = options.client;
    this.accountName = options.accountName;
    this.password = options.password;
    this.sharedSecret = options.sharedSecret;
    this.reconnectBaseMs = options.reconnectBaseMs;
    this.reconnectMaxMs = options.reconnectMaxMs;
    this.onFriendsSnapshot = options.onFriendsSnapshot;
    this.onFriendRemoved = options.onFriendRemoved;
    this.onConnected = options.onConnected;
    this.logger = options.logger ?? console;
    this.generateTwoFactorCode =
      options.generateTwoFactorCode ?? generateAuthCode;
    this.autoAcceptFriendCap =
      options.autoAcceptFriendCap ?? DEFAULT_AUTO_ACCEPT_FRIEND_CAP;
    this.autoAcceptDailyLimit =
      options.autoAcceptDailyLimit ?? DEFAULT_AUTO_ACCEPT_DAILY_LIMIT;
    this.nowMs = options.nowMs ?? Date.now;
    this.expectedBotSteamId = options.expectedBotSteamId ?? null;
    this.onFatal = options.onFatal ?? null;
    // Safety net for incomplete wiring: the identity self-check is only
    // fully protective with onFatal connected (index.ts exits the process
    // so the supervisor crash-loops and alerts). Without it a mismatch
    // still stops the bot, but nothing pages anyone — say so once, at
    // boot, at error level (a miswired identity check deserves attention,
    // not debug-level silence), when the check is armed but the exit is
    // not.
    if (this.expectedBotSteamId !== null && this.onFatal === null) {
      this.logger.error(
        '[WatchBot] expectedBotSteamId is set without onFatal: a session-id mismatch will stop the bot but NOT exit the process (no supervisor crash-loop alert) — wire onFatal to process.exit like index.ts does',
      );
    }
  }

  /** Starts the session: attaches listeners once, then logs on. */
  start(): void {
    if (this.stopped) return;
    this.attachListeners();
    this.logOn();
  }

  /**
   * Graceful stop: no more reconnects, timer cleared, session logged off.
   * Never calls process.exit — index.ts owns the process lifetime, which
   * keeps this class (and its tests) free of process globals.
   */
  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.client.logOff();
    } catch (error) {
      // Already disconnected or never connected: nothing to tear down.
      this.logger.info(
        `[WatchBot] logOff during stop threw (harmless): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSteamId(): string | null {
    try {
      return this.client.steamID?.getSteamID64() ?? null;
    } catch {
      return null;
    }
  }

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    this.client.on('loggedOn', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.info('[WatchBot] logged on to Steam');
      try {
        this.client.setPersona(SteamUser.EPersonaState.Online);
      } catch (error) {
        this.logger.error(
          `[WatchBot] setPersona failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // Identity self-check (deploy footgun guard): the site's login gate
      // checks friendship against STEAM_BOT_STEAMID, so this process MUST be
      // that account. A mismatch (typo'd env, drifted Vercel/bot-host envs,
      // or a BOT_DATA_DIR reused from another account) is FATAL, not
      // advisory — a wrong-account bot's next friendsList snapshot would
      // make reconcile read every active watch as an opt-out and delete
      // the base. Stop unconditionally (even unwired: containment is the
      // default), then hand the exit to onFatal. Unreadable session id
      // stays silent (nothing to compare yet, not evidence of drift).
      if (this.expectedBotSteamId !== null) {
        const actualBotSteamId = this.getSteamId();
        if (
          actualBotSteamId !== null &&
          actualBotSteamId !== this.expectedBotSteamId
        ) {
          const mismatchReason =
            `STEAM_BOT_STEAMID mismatch: logged in as ${actualBotSteamId} ` +
            `but configured as ${this.expectedBotSteamId} — fix the env on THIS host AND on Vercel ` +
            `(every login is gated on friendship with the configured id; a wrong-account bot ` +
            'would mass-deactivate the base on its next reconcile pass)';
          this.logger.error(`[WatchBot] ${mismatchReason} — stopping the bot (fail-fast)`);
          this.stop();
          if (this.onFatal !== null) {
            try {
              this.onFatal(mismatchReason);
            } catch (fatalError) {
              this.logger.error(
                `[WatchBot] onFatal handler failed: ${
                  fatalError instanceof Error ? fatalError.message : String(fatalError)
                } (bot already stopped)`,
              );
            }
          }
          return;
        }
      }
      if (this.onConnected) {
        try {
          this.onConnected();
        } catch (error) {
          this.logger.error(
            `[WatchBot] onConnected handler failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });

    this.client.on('disconnected', (eresult, msg) => {
      // Stopped bots ignore every client event: graceful shutdown noise,
      // and — critically — any event landing between a fatal identity
      // stop and the host's process.exit must not resurrect work against
      // the wrong account.
      if (this.stopped) return;
      this.connected = false;
      this.logger.error(
        `[WatchBot] disconnected (${describeEResult(eresult)}${msg ? `: ${msg}` : ''}) — scheduling reconnect`,
      );
      this.scheduleReconnect();
    });

    this.client.on('error', (err) => {
      // Same stopped-deafness as 'disconnected' above.
      if (this.stopped) return;
      this.connected = false;
      this.logger.error(
        `[WatchBot] client error (${describeEResult(err?.eresult)}) — scheduling reconnect`,
      );
      this.scheduleReconnect();
    });

    this.client.on('friendsList', () => {
      // Stopped-deafness is load-bearing here, not hygiene: the server's
      // initial friendsList sync typically lands inside the ~500ms window
      // between a fatal identity stop and the host's process.exit —
      // without this guard it would reconcile (and mass-deactivate)
      // against the wrong account's friends.
      if (this.stopped) return;
      if (!this.onFriendsSnapshot) return;
      try {
        // Snapshot the live map: reconcile must see a stable copy, not a
        // reference the client keeps mutating underneath it.
        this.onFriendsSnapshot({ ...this.client.myFriends });
      } catch (error) {
        this.logger.error(
          `[WatchBot] friends snapshot handler failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // Converge inbound requests that arrived while offline (no live
      // event fires for them): accept sequentially, fire-and-forget
      // (same defensive .catch precedent as above).
      this.acceptPendingRequests({ ...this.client.myFriends }).catch(
        (error: unknown) =>
          this.logger.error(
            `[WatchBot] pending-accept sweep failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      );
    });

    this.client.on('friendRelationship', (sid, relationship) => {
      // Stopped bots ignore removals AND accepts alike: post-fatal, a
      // removal must not deactivate and a request must not be accepted on
      // behalf of the wrong account.
      if (this.stopped) return;
      // WB-8 opt-out: only terminal non-friend states route to the removal
      // handler. Verified against the installed steam-user v5 source
      // (components/friends.js): this event fires on incremental
      // relationship CHANGES with (sid: SteamID, relationship), and an
      // unfriend arrives as None (the entry is then deleted from
      // myFriends).
      // NOTE: a None transition is not always a genuine unfriend — a sent
      // invite that was cancelled/expired server-side also arrives as None
      // (the lib emits on ANY incremental removal). Unlike the old comment
      // claimed, a watch row CAN exist then (status pending). Deleting it
      // is still the right call, deliberately: with no friendship and no
      // tracked invite, a pending row would sit 7 days blocking re-request
      // for an invite that can never be accepted — deletion frees the user
      // to re-request immediately and get a fresh invite. The event log
      // (watch_events) survives for audit either way.
      // Blocked is included: a blocking user is gone for our purposes
      // (no chat possible) and keeping their watch active would only burn
      // cooldown on undeliverable messages. Ambiguous states (Ignored,
      // IgnoredFriend, RequestInitiator, ...) never deactivate —
      // conservative by design.
      let steamId: string;
      try {
        steamId = sid.getSteamID64();
      } catch (error) {
        this.logger.error(
          `[WatchBot] friend event ignored: unreadable steamId: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      if (
        relationship === SteamUser.EFriendRelationship.None ||
        relationship === SteamUser.EFriendRelationship.Blocked
      ) {
        if (!this.onFriendRemoved) return;
        try {
          this.onFriendRemoved(steamId);
        } catch (error) {
          this.logger.error(
            `[WatchBot] friend-remove handler failed: steamId=${steamId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return;
      }
      if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
        // Inbound friend request (single-state model: a logged-OUT user adds
        // the bot as the explicit opt-in act, then the OpenID login gate
        // proves friendship and activates directly — no invite needed on
        // that path. The outbound invite lane still exists for the
        // post-opt-out re-watch: a surviving session hits Start while
        // unfriended, the signup route enqueues an invite, and invitePoller
        // delivers it). Accept it: Steam completes the mutual friendship
        // (verified: addFriend is documented "Send (or accept)" in the
        // installed steam-user source). Fire-and-forget by design — same
        // precedent as the post-logon pollOnce calls in index.ts:
        // acceptance converges via the Friend event / next friendsList
        // snapshot even if this races; the .catch below is defensive-only
        // (acceptFriendRequest itself never rejects for Steam failures).
        this.acceptFriendRequest(steamId).catch((error: unknown) =>
          this.logger.error(
            `[WatchBot] friend-accept handling failed: steamId=${steamId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return;
      }
      if (
        relationship === SteamUser.EFriendRelationship.Friend &&
        this.onFriendsSnapshot
      ) {
        // WB-11 live activation: friendsList only fires on full syncs (boot
        // / reconnect), never on incremental changes — so without this, an
        // acceptance on a long-online bot would sit unactivated until the
        // next restart. Forward a fresh snapshot so reconcile converges it
        // promptly (idempotent: a second pass is a verified no-op).
        // Merge the accepted id explicitly: the lib emits BEFORE updating
        // myFriends (verified in components/friends.js), so the raw map
        // does not contain them yet at this point.
        try {
          this.onFriendsSnapshot({
            ...this.client.myFriends,
            [steamId]: relationship,
          });
        } catch (error) {
          this.logger.error(
            `[WatchBot] friend-accept snapshot handler failed: steamId=${steamId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });
  }

  /** UTC-day key for the daily accept budget (YYYY-MM-DD). */
  private utcDay(): string {
    return new Date(this.nowMs()).toISOString().slice(0, 10);
  }

  /** Current FRIEND count (pending inbound/outbound never count toward it). */
  private countFriends(): number {
    const map = this.client.myFriends ?? {};
    return Object.values(map).filter(
      (rel) => rel === SteamUser.EFriendRelationship.Friend,
    ).length;
  }

  /**
   * Sink-side guard for inbound auto-accepts (Sybil bound — see the
   * DEFAULT_* docs above). Refusals log LOUDLY (error level): a capped bot
   * blocks new Watch onboarding (the login gate needs a free friend slot),
   * so hitting either ceiling is an operator-action incident, not routine
   * noise. Returns the refusal reason, or null when the accept may proceed.
   */
  private autoAcceptRefusal(): string | null {
    const friends = this.countFriends();
    if (friends >= this.autoAcceptFriendCap) {
      return (
        `friend cap reached (friends=${friends} cap=${this.autoAcceptFriendCap}): ` +
        `refusing auto-accept — operator action required (raise the bot account level / shard to a second bot)`
      );
    }
    const today = this.utcDay();
    if (this.autoAcceptDay !== today) {
      this.autoAcceptDay = today;
      this.autoAcceptsToday = 0;
    }
    if (this.autoAcceptsToday >= this.autoAcceptDailyLimit) {
      return (
        `daily accept budget exhausted (accepted=${this.autoAcceptsToday} limit=${this.autoAcceptDailyLimit} day=${today}): ` +
        `deferring remaining requests to the next UTC day`
      );
    }
    return null;
  }

  /**
   * Accepts one inbound friend request. Bounded (addFriend carries its own
   * 10s timeout) and never throws — a failure only logs loudly; the
   * inbound request stays pending server-side and converges on a later
   * snapshot sweep. Callers never await (fire-and-forget): acceptance is
   * idempotent and the Friend event / next snapshot converges state.
   *
   * Guarded by the sink-side ceilings above: a refusal skips the addFriend
   * call entirely (the request stays pending server-side for a later
   * sweep) and logs at error level so monitoring catches a filling list.
   * The budget is RESERVED synchronously before the await (check + increment
   * with no await between — atomic under Node's single thread, so a live
   * event racing the sweep cannot both slip past the check) and REFUNDED on
   * Steam failure: guard refusals and failed sends never burn budget, only
   * successful accepts do.
   */
  private async acceptFriendRequest(steamId: string): Promise<void> {
    // Same-id race guard: a live event and a sweep (or two sweeps) can both
    // hold the same id — the first owner converges it, the second skips
    // WITHOUT burning budget (the request stays pending server-side until
    // the owner's addFriend lands, so skipping is never a loss).
    if (this.acceptInFlight.has(steamId)) {
      this.logger.info(
        `[WatchBot] friend-accept already in flight: steamId=${steamId} (skipped, owner converges it)`,
      );
      return;
    }
    const refusal = this.autoAcceptRefusal();
    if (refusal !== null) {
      this.logger.error(
        `[WatchBot] friend-accept REFUSED: steamId=${steamId}: ${refusal}`,
      );
      return;
    }
    // Reserved above (autoAcceptRefusal passed) — claim the slot NOW, before
    // any await, so concurrent callers serialize on the true count. The
    // reserve day rides along: a UTC rollover between reserve and refund
    // must never perturb the fresh day's tally (the old day's slot no longer
    // exists — skipping the refund is the correct reconciliation).
    const reserveDay = this.autoAcceptDay;
    this.autoAcceptsToday += 1;
    this.acceptInFlight.add(steamId);
    try {
      await this.client.addFriend(steamId);
      this.logger.info(
        `[WatchBot] accepted inbound friend request: steamId=${steamId} ` +
          `(friends=${this.countFriends()} acceptedToday=${this.autoAcceptsToday}/${this.autoAcceptDailyLimit})`,
      );
    } catch (error) {
      // Refund: a Steam-side failure must not consume budget (a throttled
      // afternoon would otherwise strand legitimate requests behind a
      // phantom-full day) — but only into the SAME day the slot was
      // reserved under. Cross-midnight failures keep the fresh day's
      // count untouched (the lost slot belonged to yesterday, which has
      // already reset; decrementing today would silently hand the new day
      // one accept beyond its own limit).
      if (this.autoAcceptDay === reserveDay) {
        this.autoAcceptsToday = Math.max(0, this.autoAcceptsToday - 1);
      }
      this.logger.error(
        `[WatchBot] friend-accept failed: steamId=${steamId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.acceptInFlight.delete(steamId);
    }
  }

  /**
   * Deferred-accept retry entrypoint (P1-2): re-sweeps the LIVE friends map
   * for still-pending inbound requests. Called on every `friendsList`
   * snapshot AND on the 10-minute reconcile timer (see index.ts) — the
   * snapshot alone only fires on (re)logon, so without the timer a request
   * deferred by the daily budget or friend cap would sit pending for days
   * on a stable connection (no UTC-day rollover retry, no freed-slot
   * convergence). Fire-and-forget by design (never throws — the inner sweep
   * only rejects on programmer error, contained and logged below).
   */
  sweepPendingRequests(): void {
    this.acceptPendingRequests({ ...this.client.myFriends }).catch(
      (error: unknown) =>
        this.logger.error(
          `[WatchBot] pending-accept sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    );
  }

  /**
   * Accepts every inbound request in a friends snapshot, SEQUENTIALLY
   * (never a parallel burst — Steam throttles rapid addFriend calls).
   * Covers requests that arrived while offline: no live event fires for
   * them, so without this sweep they would sit pending forever.
   *
   * Stops at the first guard refusal (daily budget or friend cap): the
   * remainder stay pending server-side for the next sweep — accepting a
   * burst past the ceiling is exactly the exhaustion this guard exists to
   * prevent.
   */
  private async acceptPendingRequests(
    friendsById: Record<string, number>,
  ): Promise<void> {
    // Sweep-overlap guard: a full backlog behind slow Steam calls can outrun
    // the 10-minute timer (or collide with a reconnect snapshot) — pileups
    // would double-process ids and burst addFriend. The in-flight pass owns
    // the sweep; this one stands down (its requests are still pending
    // server-side and converge on the owner's pass or the next tick).
    if (this.sweepInFlight) {
      this.logger.info(
        '[WatchBot] pending-accept sweep already in flight (skipped overlapping pass)',
      );
      return;
    }
    this.sweepInFlight = true;
    try {
      const pending = Object.keys(friendsById).filter(
        (id) =>
          friendsById[id] === SteamUser.EFriendRelationship.RequestRecipient,
      );
      // eslint-disable-next-line no-restricted-syntax
      for (let index = 0; index < pending.length; index += 1) {
        // Pre-check so the sweep stops with ONE log line instead of one
        // REFUSED line per deferred request (acceptFriendRequest re-checks
        // anyway for the live-event path — belt and suspenders, same verdict).
        const refusal = this.autoAcceptRefusal();
        if (refusal !== null) {
          this.logger.error(
            `[WatchBot] pending-accept sweep paused: ${refusal} ` +
              `(${pending.length - index} request(s) deferred to a later sweep)`,
          );
          break;
        }
        // Sequential awaits are intentional (same precedent as
        // scripts/migrate-db.ts): gentle on Steam, one isolated failure
        // never blocks the rest (acceptFriendRequest never throws anyway).
        const id = pending[index];
        // eslint-disable-next-line no-await-in-loop
        await this.acceptFriendRequest(id);
      }
    } finally {
      this.sweepInFlight = false;
    }
  }

  private logOn(): void {
    if (this.stopped) return;
    let twoFactorCode: string;
    try {
      twoFactorCode = this.generateTwoFactorCode(this.sharedSecret);
    } catch (error) {
      this.logger.error(
        `[WatchBot] TOTP generation failed (bad shared secret?): ${
          error instanceof Error ? error.message : String(error)
        } — scheduling reconnect`,
      );
      this.scheduleReconnect();
      return;
    }
    try {
      this.client.logOn({
        accountName: this.accountName,
        password: this.password,
        twoFactorCode,
      });
    } catch (error) {
      // Synchronous throw = misconfiguration/local failure, not a Steam
      // rejection (those arrive async via 'error'). Back off anyway.
      this.logger.error(
        `[WatchBot] logOn threw synchronously: ${
          error instanceof Error ? error.message : String(error)
        } — scheduling reconnect`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(
      this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1),
      this.reconnectMaxMs,
    );
    this.logger.info(
      `[WatchBot] reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logOn();
    }, delayMs);
  }
}

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

export interface WatchBotOptions {
  client: SteamUser;
  accountName: string;
  password: string;
  sharedSecret: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
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
      this.connected = false;
      this.logger.error(
        `[WatchBot] disconnected (${describeEResult(eresult)}${msg ? `: ${msg}` : ''}) — scheduling reconnect`,
      );
      this.scheduleReconnect();
    });

    this.client.on('error', (err) => {
      this.connected = false;
      this.logger.error(
        `[WatchBot] client error (${describeEResult(err?.eresult)}) — scheduling reconnect`,
      );
      this.scheduleReconnect();
    });

    this.client.on('friendsList', () => {
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
    });

    this.client.on('friendRelationship', (sid, relationship) => {
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

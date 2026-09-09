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

export interface BotSnapshotListener {
  (friendsById: Record<string, number>): void;
}

export interface BotLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface WatchBotOptions {
  client: SteamUser;
  accountName: string;
  password: string;
  sharedSecret: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  onFriendsSnapshot?: BotSnapshotListener;
  logger?: BotLogger;
  /** Injected for tests (avoids real TOTP computation). */
  generateTwoFactorCode?: (sharedSecret: string) => string;
}

/** Human-readable EResult for logs (numeric fallback when unknown). */
const describeEResult = (eresult: number | undefined): string => {
  if (typeof eresult !== 'number') return 'unknown';
  const name =
    (SteamUser.EResult as unknown as Record<number, string>)[eresult] ??
    null;
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

  private readonly logger: BotLogger;

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

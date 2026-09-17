/**
 * Shared analytics types, extracted from the retired JSON-file store so
 * the Turso DAL (db.ts), the migration scripts, and the Vercel API routes
 * all share a single source of truth for the SearchRecord contract.
 */

export interface FriendRecord {
  steamId: string;
  nickname?: string | null;
  gcName?: string | null;
  /** Raw "close friend" score from the mutual-friend-density algorithm. */
  mutualCount?: number | null;
  /** Computed probability (0-100) that this is actually a close friend. */
  probability?: number | null;
  countryCode?: string | null;
}

export interface ProfileRecord {
  steamId: string;
  steamUrl?: string | null;
  nickname?: string | null;
  gcName?: string | null;
  countryCode?: string | null;
  stateCode?: string | null;
  /**
   * Numeric in the client payload in practice (geolocation city ID), even
   * though older data files sometimes carry it as a string. The Turso schema
   * stores it as TEXT; writers normalize via nullableText() in
   * src/lib/analytics/sqlHelpers.
   */
  cityId?: string | number | null;
}

export interface LocationGuess {
  location: {
    cityName?: string;
    stateName?: string;
    countryName?: string;
    countryCode?: string;
  };
  probability: number;
}

/**
 * One friend -> GamersClub name pair, sent by the client backfill
 * (POST /api/recordAnalyticsFriends) to fill friends.gc_name with a name the
 * UI had already resolved (the friend cards fetch it after render, so the
 * initial recordAnalytics payload can't carry it). Only CONFIRMED names —
 * a null/missing value means "unknown", not "no GC profile", and is never
 * sent here (see friendGcNameStore).
 */
export interface FriendGcNameEntry {
  steamId: string;
  gcName: string;
}

export interface CheaterProbabilityRecord {
  score: number;
  bannedFriendsCount?: number | null;
  computedAt: string;
}

export interface GameSnapshotEntry {
  name: string;
  playtimeHours: number;
}

export interface SearchRecord {
  id: string;
  searchedAt: string;
  profile: ProfileRecord;
  friends: FriendRecord[];
  gamesSnapshot?: GameSnapshotEntry[] | null;
  isCSActive?: boolean | null;

  // ---- Everything below was added after the first version. ----
  /** Locale of whoever ran the search ('pt' | 'en' | ...). */
  requesterLocale?: string | null;
  /** Country of whoever ran the search (Vercel geo header, not the target's). */
  requesterCountry?: string | null;
  /** Browser language preference of whoever ran the search (navigator.language). */
  requesterBrowserLanguage?: string | null;
  device?: 'mobile' | 'desktop' | null;
  /** Top predicted location(s) for the searched profile. */
  locationGuess?: LocationGuess[] | null;
  /** Filled in later via attachCheaterProbability(), once the user requests it. */
  cheater?: CheaterProbabilityRecord | null;
  /** Wall-clock time, in ms, that the full search took client-side. */
  durationMs?: number | null;
}

export type NewSearchInput = Omit<
  SearchRecord,
  'id' | 'searchedAt' | 'cheater'
>;

// ---------------------------------------------------------------------------
// Watch Bot (Epic: notify user when their profile is searched).
// No email anywhere by design — the Steam OpenID login is the opt-in proof
// and Steam chat (via the bot friendship) is the delivery channel.
// ---------------------------------------------------------------------------

/** Lifecycle of a watched profile: invite sent vs friendship observed. */
export type WatchStatus = 'pending' | 'active';

/** Poller lane: invite/notify senders, post-confirm welcome sender, and
 * confirm-link resend requests (never contend — kind is in every claim
 * predicate, so concurrent pollers cannot grab each other's rows). */
export type WatchEventKind = 'invite' | 'notify' | 'welcome' | 'confirm_resend';

/**
 * Event lifecycle: queued (pollable) -> claimed (transient: a worker owns
 * it right now) -> sent | dropped (terminal). 'claimed' is worker-local
 * transient state, never a resting state — see resetStaleClaims.
 */
export type WatchEventStatus = 'queued' | 'claimed' | 'sent' | 'dropped';

export interface WatchedProfile {
  steamId: string;
  status: WatchStatus;
  /** Requester locale for bot messages ('pt' | 'en' | ...), null when unknown. */
  locale: string | null;
  requestedAt: string;
  activatedAt: string | null;
  /** Last successful notify send (Epic 4 cooldown clock). */
  lastNotifiedAt: string | null;
}

export interface WatchEvent {
  id: number;
  /** The search that produced a notify; null for invites (not tied to any search). */
  searchId: string | null;
  steamId: string;
  kind: WatchEventKind;
  status: WatchEventStatus;
  createdAt: string;
  claimedAt: string | null;
  sentAt: string | null;
}

/**
 * Watch account (single-state model: the login registry).
 * One row per Steam profile that ever logged in: `created_at` keeps the
 * FIRST login (never reset), `last_login_at` tracks the latest one (the
 * ops answer to "who is logging into the site"). The confirm columns
 * (`confirmed_at`, `confirm_token_hash`, `confirm_expires_at`) are still
 * written on the confirm-link lane (`createAccount` / `issueConfirmToken`
 * / `consumeConfirmToken` serve the post-opt-out re-watch Start → link →
 * click flow) — the fresh single-state lane just never touches them.
 */
export interface WatchAccount {
  steamId: string;
  createdAt: string;
  confirmedAt: string | null;
  /** SHA-256 hex of the pending token (never the token itself). */
  confirmTokenHash: string | null;
  confirmExpiresAt: string | null;
  /** Requester locale for bot messages, null when unknown. */
  locale: string | null;
  /**
   * Last successful login (ISO-8601 UTC), null until migration 010 +
   * first recordLogin. Optional (not load-bearing): purely an ops/audit
   * field — the confirm-stack fixtures predate it and don't read it.
   */
  lastLoginAt?: string | null;
}

/**
 * One expired-but-never-clicked confirmation (confirm-link expiry poller
 * input). The poller sends the single "link expired, generate a new one"
 * notice per token generation: `expiresAt` identifies the generation, so
 * re-issuing (which always sets a fresh expiry) implicitly re-arms the
 * notice without any extra clearing write.
 */
export interface ExpiredConfirmCandidate {
  steamId: string;
  /** watched_profiles locale first (bot message rule: watch, then account). */
  watchLocale: string | null;
  accountLocale: string | null;
  /** The expired confirm_expires_at that has not been noticed yet. */
  expiresAt: string;
}

/**
 * Inbox row: one recorded search on the watched profile, newest first.
 * steamId is the query key (echoed by the route, not repeated per row).
 * The React key is searchId (searches.id PK — stable forever, unlike
 * rowids). No message text is stored (the inbox renders the shared WB-15
 * base text instead) and no requester PII travels — only the searched
 * profile's own search metadata (when it ran, whether the cheater report
 * was opened for it).
 */
export interface WatchNotification {
  /** Producing search id (searches.id). */
  searchId: string;
  /** When the viewed search ran (searches.searched_at, UTC ISO). */
  searchedAt: string;
  /** Whether the searcher opened the cheater report (cheater_results row). */
  cheaterChecked: boolean;
}

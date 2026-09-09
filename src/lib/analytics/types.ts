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

export type NewSearchInput = Omit<SearchRecord, 'id' | 'searchedAt' | 'cheater'>;

// ---------------------------------------------------------------------------
// Watch Bot (Epic: notify user when their profile is searched).
// No email anywhere by design — the Steam friendship is the opt-in proof
// and Steam chat is the delivery channel.
// ---------------------------------------------------------------------------

/** Lifecycle of a watched profile: invite sent vs friendship observed. */
export type WatchStatus = 'pending' | 'active';

/** Poller lane: invite sender vs notify sender (never contend). */
export type WatchEventKind = 'invite' | 'notify';

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
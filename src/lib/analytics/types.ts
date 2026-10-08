/**
 * Shared analytics types, extracted from the retired JSON-file store so
 * the Turso DAL (db.ts), the migration scripts, and the Vercel API routes
 * all share a single source of truth for the SearchRecord contract.
 */
import type { FriendsVisibility } from './friendsVisibility';

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

/**
 * Visibility of the searched profile's friends list at search time.
 * Single source of truth lives in ./friendsVisibility (dependency-free so
 * the DAL, the route parser and the migration scripts can all share it);
 * re-exported here so existing `@/lib/analytics/types` imports keep
 * working.
 */
export type { FriendsVisibility };

export interface SearchRecord {
  id: string;
  searchedAt: string;
  profile: ProfileRecord;
  friends: FriendRecord[];
  /** How the friends list resolved (search_meta.friends_visibility). Null for legacy rows. */
  friendsVisibility?: FriendsVisibility | null;
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
  /**
   * SteamID64 of the logged-in viewer who ran the search, resolved
   * server-side from the session cookie (never client-supplied). Null for
   * anonymous searches and every row predating the column — powers the
   * per-account "my search history" panel. Privacy: owner-signed
   * expansion beyond coarse-geo-only (see 020_searcher_steam_id.sql).
   */
  searcherSteamId?: string | null;
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

/** Poller lane: invite/notify senders, post-confirm welcome sender,
 * confirm-link resend requests, and ban-reveal alerts (never contend —
 * kind is in every claim predicate, so concurrent pollers cannot grab
 * each other's rows). */
export type WatchEventKind =
  | 'invite'
  | 'notify'
  | 'welcome'
  | 'confirm_resend'
  | 'ban_alert';

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
 * base text instead). The only requester-side datum is the coarse
 * 2-letter country (a flag in the inbox row — deliberate product
 * decision; never IP, city, locale or any other search_meta column).
 * Null when the geo was unknown or the row predates search_meta.
 */
export interface WatchNotification {
  /** Producing search id (searches.id). */
  searchId: string;
  /** When the viewed search ran (searches.searched_at, UTC ISO). */
  searchedAt: string;
  /** Whether the searcher opened the cheater report (cheater_results row). */
  cheaterChecked: boolean;
  /** Searcher country (search_meta.requester_country, 2-letter, uppercase). */
  requesterCountry: string | null;
}

/**
 * "My searches" row: one recorded search RUN BY the viewer, newest first
 * (searches.searcher_steam_id = session SteamID). The React key is
 * searchId (searches.id PK). Null-profile rows (hand edits) are dropped
 * by the reader, mirroring mapSearchRecord. Rows predating the column
 * (NULL searcher) never appear — history starts at deploy.
 *
 * Minimal projection on purpose: nickname + cheater flag is all the
 * modal renders (the player link is built from steamId). No URLs, no
 * geo — less data over the wire, less to leak.
 */
export interface SearcherHistoryEntry {
  /** Producing search id (searches.id). */
  searchId: string;
  /** When the search ran (searches.searched_at, UTC ISO). */
  searchedAt: string;
  /** Searched target profile id. */
  steamId: string;
  /** Target nickname at search time (may be null). */
  nickname: string | null;
  /** Whether the cheater report was opened for this search. */
  cheaterChecked: boolean;
}

// ---------------------------------------------------------------------------
// Ban Reveal Phase 1 (cheater-review-triggered subscriptions).
// Opposite direction from watched_profiles: the SUBSCRIBER is the person
// who opened the cheater report, the TARGET is the reviewed profile. The
// two tables split sweep cardinality (one row per distinct target) from
// notification cardinality (one row per subscriber x target).
// ---------------------------------------------------------------------------

/** Ban-check source. Phase 1 only ever reads/writes 'steam'. */
export type BanWatchSource = 'steam';

/** One distinct (profile, source) row checked by the sweep. */
export interface BanWatchTarget {
  targetSteamId: string;
  source: BanWatchSource;
  /** Last sweep verdict (false until the first sighting confirms a ban). */
  lastKnownBanned: boolean;
  /** Last sweep sighting (ISO-8601), null until the sweep sees it once. */
  lastBanCheckedAt: string | null;
}

/** One subscriber x target subscription (permanent in Phase 1: no unsubscribe UI). */
export interface BanWatchSubscription {
  id: number;
  subscriberSteamId: string;
  targetSteamId: string;
  /** Originating search, audit trail only (nullable). */
  searchId: string | null;
  subscribedAt: string;
  /** Set once an alert fired for the current ban episode — or at subscribe
   * time when the target was already banned (pre-existing bans never alert). */
  notifiedAt: string | null;
}

/**
 * Inbox row for the ban-alert stream: deliberately generic (no target
 * steamId, nickname, or profile link) until the subscriber clicks through
 * the reveal route. `id` is the subscription id — the opaque handle the
 * reveal route accepts, so the list payload never names the profile.
 */
export interface BanAlertNotification {
  /** Subscription id (ban_watch_subscriptions.id) — reveal handle. */
  id: number;
  /** When the subscription was created (ISO-8601). */
  subscribedAt: string;
  /** When the ban alert fired (ISO-8601, always non-null in this stream). */
  notifiedAt: string;
}

/**
 * One searched profile aggregated for the programmatic player sitemap
 * (P0 SEO): SteamID64 with demand signal (search count) and freshness
 * (latest search). Nickname is observability only — the sitemap entry
 * itself carries just the URL + lastModified (the page title resolves
 * live from Steam at render/crawl time).
 */
export interface PopularProfile {
  /** Resolved SteamID64 (17 digits — malformed rows never leave the DAL). */
  steamId: string;
  /** Latest recorded nickname, null when the search stored none. */
  nickname: string | null;
  /** Newest search of this profile (ISO-8601) — sitemap lastModified. */
  lastSearchedAt: string;
  /** Finished searches recorded for this profile (always >= minSearches). */
  searchCount: number;
}

// ---------------------------------------------------------------------------
// Watch dashboard (read-only aggregates for the analytics dashboard).
// These DTOs carry NO secrets: explicit columns only — token hashes,
// anti-loop hashes and session material never leave the database. Timestamps
// drive the per-day charts; statuses drive the funnel. Everything optional
// or nullable degrades to an empty panel, never a failed dashboard.
// ---------------------------------------------------------------------------

/** One accounts row, reduced to funnel dimensions. */
export interface WatchDashboardAccount {
  createdAt: string;
  confirmedAt: string | null;
  locale: string | null;
  lastLoginAt: string | null;
}

/** One watched_profiles row, reduced to funnel dimensions. */
export interface WatchDashboardWatched {
  requestedAt: string;
  activatedAt: string | null;
  status: WatchStatus;
  locale: string | null;
}

/** One watch_events row, reduced to delivery dimensions. */
export interface WatchDashboardEvent {
  kind: WatchEventKind;
  status: WatchEventStatus;
  createdAt: string;
  sentAt: string | null;
}

/** Bot liveness snapshot at render time (single-row table, no history). */
export interface WatchDashboardLiveness {
  beatAt: string;
  connected: boolean;
}

/**
 * Everything the dashboard's Watch section renders. Null (not {}) when the
 * reads fail — the section renders "unavailable" instead of failing the
 * whole page (fail-open, same contract as a missing analytics DB).
 */
export interface WatchDashboardData {
  accounts: WatchDashboardAccount[];
  watched: WatchDashboardWatched[];
  events: WatchDashboardEvent[];
  liveness: WatchDashboardLiveness | null;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Steam-login funnel (CTA click -> completed login). Aggregate-only DTO: the
// dashboard never sees session ids, only counts plus the per-session
// conversion rate. Null (not {}) when the reads fail — same fail-open
// contract as the Watch section above.
// ---------------------------------------------------------------------------

/**
 * The instrumented funnel steps (mirrors the login_funnel_events CHECK,
 * widened by 017). login_cta_clicked is client-beaconed; the other three
 * are server-side only (the parser rejects them from the browser so
 * conversions can't be forged).
 */
export type LoginFunnelEventKind =
  | 'login_cta_clicked'
  | 'login_callback_hit'
  | 'login_waiting_entered'
  | 'login_completed';

/** Funnel steps the server is allowed to record (everything but the CTA). */
export type ServerLoginFunnelEvent = Exclude<
  LoginFunnelEventKind,
  'login_cta_clicked'
>;

/** Popup steps (mirrors the login_popup_events CHECK — separate table). */
export type LoginPopupEventKind =
  | 'login_popup_shown'
  | 'login_popup_cta_clicked';

/** Popup aggregates, embedded in LoginFunnelStats. */
export interface LoginPopupStats {
  /** Raw login_popup_shown rows (every display, including repeats). */
  popupShown: number;
  /** Distinct anon sessions shown the popup at least once. */
  popupShownSessions: number;
  /** Raw login_popup_cta_clicked rows. */
  popupClicks: number;
  /** Distinct anon sessions that clicked at least once. */
  popupClickSessions: number;
  /**
   * Distinct anon sessions with a popup CTA click strictly BEFORE a
   * login_completed (temporal join at read time — see getLoginFunnelStats):
   * signins the popup gets credit for. NULL-session completions can never
   * attribute (no session to join on).
   */
  popupAttributedSignins: number;
  /**
   * popupAttributedSignins / popupClickSessions * 100. Null while no popup
   * click session exists yet (renders as "—", never 0% or NaN).
   */
  popupConversionRate: number | null;
}

/**
 * Promo modals with engagement instrumentation. Single source of truth
 * for the modal allowlist: the parser (input.ts) and the DAL (db.ts)
 * derive from these tuples, so a new modal can't land in one layer and
 * silently 400/reject in another. The SQL layer mirrors only the EVENT
 * set in a CHECK (stable by design — a modal lifecycle has exactly these
 * four transitions); modal itself has no CHECK (see 018), and the
 * integration test pins both halves.
 */
export const MODAL_KINDS = ['sponsor', 'support', 'login_prompt'] as const;

/** Promo modal with engagement instrumentation (no SQL CHECK by design). */
export type ModalKind = (typeof MODAL_KINDS)[number];

/** Per-modal engagement steps. Single source of truth, same as MODAL_KINDS. */
export const MODAL_EVENTS = [
  'shown',
  'cta_clicked',
  'closed',
  'dismissed',
] as const;

/** Per-modal engagement step (mirrors the modal_events event CHECK). */
export type ModalEventKind = (typeof MODAL_EVENTS)[number];

/** Raw per-modal engagement counts (every event, including repeats). */
export interface ModalStats {
  /** Times the modal was displayed. */
  shown: number;
  /** Times its CTA was clicked (outbound/donation action or sign-in). */
  ctaClicks: number;
  /** Times it was closed via X (or Esc where supported). */
  closed: number;
  /** Times users asked to never see it again. */
  dismissed: number;
}

/** Promo-modal aggregates for the analytics dashboard (own table, own read). */
export interface ModalDashboardStats {
  sponsor: ModalStats;
  support: ModalStats;
  loginPrompt: ModalStats;
  generatedAt: string;
}

/**
 * Dashboard search aggregates (all-time, read-only). Single snapshot read
 * for every count-based panel, so the page never ships full tables to the
 * browser: friends/games/locations travel here as GROUP BY results
 * (hundreds of rows) instead of raw child rows (hundreds of thousands).
 */
export interface DashboardSummaryStats {
  /** Total recorded searches. */
  totalSearches: number;
  /** Distinct target Steam IDs. */
  uniqueProfiles: number;
  /** Distinct friend Steam IDs across all searches. */
  uniqueFriends: number;
  /** Total friend rows (avg-friends-per-search = totalFriends/totalSearches). */
  totalFriends: number;
  /** Searches whose friends list came back private. */
  privateListSearches: number;
  /** Searches with a non-empty GamersClub name. */
  gcMatches: number;
  /** Mean search duration in ms (NULL when no search recorded one). */
  avgDurationMs: number | null;
}

/** One cheater row for the dashboard (joined, tiny table by nature). */
export interface DashboardCheaterRow {
  searchedAt: string;
  steamId: string;
  nickname: string | null;
  gcName: string | null;
  countryCode: string | null;
  steamUrl: string | null;
  friendCount: number;
  score: number;
  bannedFriendsCount: number | null;
  computedAt: string;
}

/** Per-game aggregates for the dashboard charts. */
export interface DashboardGameRow {
  name: string;
  totalHours: number;
  profilesCount: number;
}

/** Top-N entry (profiles / friends ranking). */
export interface DashboardTopEntry {
  steamId: string;
  nickname: string | null;
  gcName: string | null;
  countryCode: string | null;
  count: number;
}

/** Pre-aggregated location bucket (raw location JSON + count). */
export interface DashboardLocationRow {
  location: string;
  count: number;
}

/** Everything the dashboard renders except the capped history table. */
export interface DashboardStats {
  summary: DashboardSummaryStats;
  /**
   * Every searched_at, oldest first. Day/hour/today/week bucketing stays
   * client-side (browser-local timezone, exactly as before) — timestamps
   * are ~25 bytes each, so even 100k searches stay a ~2.5MB sidecar next
   * to the megabytes the child tables used to cost. Revisit with
   * server-side UTC bucketing if this list ever dominates the payload.
   */
  searchTimestamps: string[];
  localeCounts: Record<string, number>;
  browserLangCounts: Record<string, number>;
  deviceCounts: Record<string, number>;
  countryCounts: Record<string, number>;
  cheaterRows: DashboardCheaterRow[];
  games: DashboardGameRow[];
  /**
   * All-time profile denominator for per-profile game averages. Read from
   * the profiles table, not from any entries array (the history window is
   * capped — averaging over it would inflate every per-profile number).
   */
  totalProfilesForGames: number;
  /** Profiles with is_cs_active = 1. */
  csActiveCount: number;
  locations: DashboardLocationRow[];
  topProfiles: DashboardTopEntry[];
  topFriends: DashboardTopEntry[];
  generatedAt: string;
}

/** Funnel aggregates for the analytics dashboard. */
export interface LoginFunnelStats {
  /** Raw login_cta_clicked rows (every click, including repeats). */
  ctaEvents: number;
  /** Distinct anon sessions that clicked at least once. */
  ctaSessions: number;
  /**
   * Distinct anon sessions with a proven return from Steam (OpenID state +
   * assertion verified — forged/random callback hits never reach the
   * writer). ctaSessions MINUS callbackSessions is the "left at Steam"
   * abandon, modulo the usual best-effort caveats (a return whose ctx
   * cookie was unreadable records a NULL session and reads as abandon).
   */
  callbackSessions: number;
  /**
   * Clicking sessions with NO proven return AND no completion
   * (set-difference in SQL, not arithmetic: a callback_hit without a click
   * row exists when the CTA beacon was blocked but the ctx cookie survived,
   * so `cta − returned` would mislabel it). Sessions that completed under
   * the pre-mid-step writer (no callback row exists for them) are excluded
   * so legacy logins never read as abandon. Same cookie caveat as above: a
   * NULL-session return can't be joined back to its click, so heavy cookie
   * loss inflates this alongside unattributedCompletions — read them
   * together.
   */
  steamAbandonSessions: number;
  /** Distinct anon sessions held in the waiting room (verified, not a friend yet). */
  waitingSessions: number;
  /**
   * Waiting-room sessions with NO per-session completion — "logged into
   * Steam but never added the bot" (pending expired unclicked). Users
   * still inside their 30min pending window read as leak until they
   * complete; the panel is cumulative with no time window (accepted debt,
   * same as the rest of the funnel).
   */
  waitingLeakSessions: number;
  /** Raw login_completed rows (every completion, incl. beacon-loss ones). */
  completions: number;
  /**
   * Distinct anon sessions that completed AND have a recorded CTA click
   * (intersection — see getLoginFunnelStats): completions whose CTA beacon
   * was lost (ad-blockers, navigation raced the keepalive) stay in the raw
   * `completions` total but never enter the rate, keeping it honest.
   */
  completedSessions: number;
  /**
   * Completions with a NULL/unknown session — the correlation-pipeline
   * health signal. Growing while the rate sits at 0% means the ctx-cookie
   * read broke on the server (a bug), not that users stopped converting.
   */
  unattributedCompletions: number;
  /**
   * completedSessions / ctaSessions * 100. Null while no CTA session exists
   * yet (renders as "—", never 0% or NaN). Distinct-session based so
   * re-clicks/re-logins can't inflate it, and intersection-based so lost
   * beacons can't push it past 100% — both by SQL construction.
   */
  conversionRate: number | null;
  /** Popup-prompt aggregates (own table, same read). */
  popup: LoginPopupStats;
  generatedAt: string;
}

'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { countryDisplayName, normalizeCountryCode } from '@/lib/countryFlag';
import {
  getInboxSearchDateTime,
  resolveWatchLocale,
  watchPlayerPageUrl,
  watchProfileUrl,
} from '@/lib/watch/notificationText';
import { isWatchTokenShape } from '@/lib/watch/tokens';
import { isSteamId64 } from '@/lib/steamId';
import { WATCH_INBOX_DEFAULT_LIMIT } from '@/lib/watch/limits';
import resolveLoginNext from '@/lib/watch/loginNext';
import { usePathname } from '@/navigation';
import {
  getLastSeenSearchedAt,
  latestSearchedAt,
  setLastSeenSearchedAt,
} from '@/app/templates/Home/hooks/watch/watchReadState';
import CountryFlag from '@/app/components/CountryFlag';
import DropdownPanel from '@/app/components/DropdownPanel/DropdownPanel';

interface InboxNotification {
  /** Producing search id (searches.id — the React key, stable forever). */
  searchId: string;
  /** When the viewed search ran (searches.searched_at, UTC ISO). */
  searchedAt: string;
  /** Whether the searcher opened the cheater report for that search. */
  cheaterChecked: boolean;
  /** Searcher country (2-letter, uppercase) — null when unknown/legacy. */
  requesterCountry: string | null;
}

/**
 * Ban-alert row (Ban Reveal Phase 1): deliberately generic — id plus
 * timestamps only, never the target steamId. The target is disclosed only
 * through the instrumented reveal click (POST /api/watch/ban-reveal).
 */
interface InboxBanAlert {
  /** Subscription id — the opaque reveal handle. */
  id: number;
  subscribedAt: string;
  notifiedAt: string;
}

const BAN_SEEN_PREFIX = 'banAlertSeen_';

const getBanSeenMax = (steamId: string): number => {
  try {
    const raw = localStorage.getItem(`${BAN_SEEN_PREFIX}${steamId}`);
    const n = raw === null ? 0 : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
};

const setBanSeenMax = (steamId: string, maxId: number): void => {
  try {
    localStorage.setItem(`${BAN_SEEN_PREFIX}${steamId}`, String(maxId));
  } catch {
    // localStorage full/blocked: badge overcounts, never an error screen.
  }
};

const NOTIFICATIONS_LIMIT = WATCH_INBOX_DEFAULT_LIMIT;
/**
 * One inbox row's text: a localized per-search sentence
 * (messages/*.json, never hardcoded) plus a "view here" anchor pointing
 * at the analyzed Steam profile.
 *
 * Copy varies by cheaterChecked (opened report or not); the date parts
 * come from the row's searched_at. The anchor is a dedicated element, not
 * a raw URL glued to the sentence. Viewed-at timestamp and cheater flag
 * line live below the text.
 *
 * Word-order note: body + anchor + trailing render as three fixed
 * segments, which holds for all 5 supported locales (all SVO) — that is
 * why the body itself is ALREADY rich text (a single <flag> slot holding
 * the locale preposition plus the searcher-country flag image), so a
 * future non-SVO locale only moves the slot. The slot replaces the
 * country NAME, so no locale ever needs a gendered article/preposition
 * ("do Brasil" vs "da Argentina"); the bare name also renders visibly
 * in the row metadata line (tooltips do not exist on touch screens)
 * and in the flag's hover title, both inflection-free.
 */
function NotifyItemText({
  locale,
  steamId,
  cheaterChecked,
  searchedAt,
  antiLoopToken,
  requesterCountry,
  countryName,
}: {
  locale: string;
  steamId: string;
  cheaterChecked: boolean;
  searchedAt?: string | null;
  antiLoopToken?: string | null;
  requesterCountry: string | null;
  /** Intl display name for requesterCountry (parent computes once per row). */
  countryName: string | null;
}) {
  const translator = useTranslations('Watch');
  const resolved = resolveWatchLocale(locale);
  // Same link target as the bot's notify ("see what they saw"): origin is
  // browser-known, no env needed. The anti-loop token rides along when the
  // server minted one for this inbox open (see applyInboxPayload): opening
  // your own profile then records NOTHING instead of a fresh search, which
  // used to notify again per click (inbox + a new bot message) — a
  // self-click feedback loop. Null (live bot-chat token outstanding, mint
  // failure, stale/double-clicked link) degrades to a plain link: the
  // player page records normally, exactly like before.
  const siteUrl = typeof window !== 'undefined' ? window.location.origin : null;
  const link =
    siteUrl === null
      ? watchProfileUrl(steamId)
      : watchPlayerPageUrl(siteUrl, resolved, steamId, antiLoopToken ?? null);
  // Locale-correct date/time (en MM/DD 12h, pt DD/MM 24h, ...). The row
  // parser only ever passes a finite ISO searchedAt; empty strings keep
  // the interpolation defined (never undefined) on the impossible path.
  const dateValues: Record<string, string> = getInboxSearchDateTime(
    searchedAt,
    locale,
  ) ?? { date: '', time: '' };
  // Searcher flag: image embedded mid-sentence via the <flag> rich-text
  // slot, tooltip + screen-reader name from Intl (no translated strings,
  // no gendered articles). Null country (unknown geo, legacy rows) or an
  // unresolvable code renders nothing — the sentence stays grammatical
  // (the message's preposition rides inside the tag, so it vanishes
  // together with the flag; the leftover double space collapses under
  // whitespace-pre-line). The name arrives as a prop (computed once per
  // row by the parent — see renderPanelBody), never re-derived here.
  const flagImg =
    countryName === null || requesterCountry === null ? null : (
      <CountryFlag
        code={requesterCountry}
        label={countryName}
        className="align-middle"
      />
    );
  return (
    <p className="whitespace-pre-line text-sm text-gray-200">
      {translator.rich(
        cheaterChecked
          ? 'watchInboxItemCheckedBody'
          : 'watchInboxItemPlainBody',
        {
          ...dateValues,
          // eslint-disable-next-line react/no-unstable-nested-components -- next-intl rich-text slots mandate a mapper function; this one is never rendered as <Flag/>, it only returns the prebuilt element above.
          flag: (chunks) =>
            flagImg === null ? null : (
              <>
                {chunks} {flagImg}
              </>
            ),
        },
      )}{' '}
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className="break-all text-blue-400 underline hover:text-blue-300 font-bold"
      >
        {translator('watchInboxItemViewHere')}
      </a>{' '}
      {translator('watchInboxItemTrailing')}
    </p>
  );
}

/**
 * Watch inbox bell + dropdown (WB-14).
 *
 * Reads EVERY recorded search on the session SteamID prop and presents
 * them newest-first — no cooldown gate (the bot's 24h delivery discipline
 * lives at send time; the inbox is the relaxed side, so
 * cooldown-suppressed views still appear here). Each row renders a
 * localized inbox sentence (messages/*.json, never hardcoded) with the
 * search date parts plus a "view here" anchor. Language note: items render
 * in the PAGE locale, while the bot sent in the stored requester locale.
 * If the user changes site language afterwards, the inbox wording can
 * legitimately differ from the Steam chat wording for the same event.
 * Only search id + timestamp travel over the API; text is composed
 * client-side from the localized templates. By data-model design every
 * item shares the same sentence shape and differs only by timestamp (no
 * per-event content is stored) — that is the intended look, not a
 * rendering bug.
 *
 * Unread state is a local per-profile watermark (max searched_at in
 * localStorage — no `read_at` column), keyed by the session SteamID prop:
 * opening the inbox marks everything visible as seen. Timestamp (not id)
 * cursor: search ids embed wall-clock plus randomness, so they are not
 * strictly ordered. No interval
 * polling by design (fetch on mount/prop change, refetch on open and on
 * manual retry only). A 401 (session died mid-use) swaps the panel for a
 * login link instead of failing silently.
 *
 * Accessibility: real <button> with an interpolated aria-label (the count
 * never relies on color alone), aria-expanded, Escape closes, click-outside
 * closes, focus moves into the panel on open and back to the bell on
 * close, error/empty states are role="alert"/plain text (never silent).
 */
function WatchInbox({ steamId }: { steamId: string }) {
  const translator = useTranslations('Watch');
  // Page locale drives item language AND timestamp formatting (the bot may
  // have sent in the stored requester locale — same base text family).
  const locale = useLocale();
  // Post-login return: same helper as the navbar sign-in, so a mid-use
  // expiry lands back on the page the user was on (the login route
  // re-validates `next` as an internal path server-side).
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // Ban Reveal stream (Phase 1, option (a): one bell, one badge). Separate
  // state from the search rows above: different shape (generic until
  // reveal), different seen-tracking (max subscription id watermark, not a
  // searched_at cursor), same bell.
  const [banAlerts, setBanAlerts] = useState<InboxBanAlert[]>([]);
  const [banUnread, setBanUnread] = useState(0);
  // Revealed targets by subscription id (target steamId only lands here
  // AFTER the instrumented POST — the list payload never names it).
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [revealing, setRevealing] = useState<Record<number, boolean>>({});
  const [revealError, setRevealError] = useState<Record<number, boolean>>({});
  // Server-minted loop guard for this open (null = slot busy or mint
  // failed — links stay plain). Shared by every row: the token slot is
  // single per profile and single-use, so the first self-click consumes
  // it and later ones degrade to normal searches, never errors.
  const [inboxToken, setInboxToken] = useState<string | null>(null);
  const [monthlyCount, setMonthlyCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const fetchSeqRef = useRef(0);

  // The SteamID arrives as a server-verified prop (login session) — no
  // localStorage identity, no sync listeners. A prop change resets
  // everything (never mix profiles).
  // Shared parse-and-apply for both the main fetch and the cursorless
  // retry below: one definition, so the two paths cannot drift apart
  // (row shape, server-count fallback, mark-as-seen). Stale responses
  // never land (seq check first). `countSince` is the cursor the fetch
  // was issued with (null = cursorless): the local unread fallback only
  // filters when the server count is absent AND the fetch had a cursor.
  const applyInboxPayload = useCallback(
    (
      body: {
        notifications?: unknown;
        unreadCount?: unknown;
        monthlyCount?: unknown;
        antiLoopToken?: unknown;
        banAlerts?: unknown;
      } | null,
      markVisibleAsSeen: boolean,
      seq: number,
      countSince: string | null,
    ): void => {
      const rows: unknown[] = Array.isArray(body?.notifications)
        ? body.notifications
        : [];
      const parsed: InboxNotification[] = [];
      rows.forEach((row) => {
        if (typeof row !== 'object' || row === null) return;
        const { searchId, searchedAt, cheaterChecked, requesterCountry } =
          row as {
            searchId?: unknown;
            searchedAt?: unknown;
            cheaterChecked?: unknown;
            requesterCountry?: unknown;
          };
        // searchId is the row identity (React key) AND the time anchor —
        // both are required, so a row missing either is dropped, never
        // rendered half-true. Legacy sentAt/id-only shapes (pre-split
        // servers mid-rollout) fall out here: no row is better than a row
        // with a wrong when.
        if (typeof searchId !== 'string' || searchId.length === 0) return;
        if (
          typeof searchedAt !== 'string' ||
          !Number.isFinite(Date.parse(searchedAt))
        ) {
          return;
        }
        // Country is garnish (old servers omit it): malformed values
        // degrade to a flagless row, never drop the notification.
        // Single choke point (lib/countryFlag): same normalization as
        // the DAL read and the write parser.
        parsed.push({
          searchId,
          searchedAt,
          cheaterChecked: cheaterChecked === true,
          requesterCountry: normalizeCountryCode(requesterCountry),
        });
      });
      // Stale-response guard: an identity switch mid-flight must not let
      // the previous profile's rows land in the new profile's inbox.
      if (fetchSeqRef.current !== seq) return;
      setNotifications(parsed);
      // Ban-alert stream: validate strictly (id is the reveal handle AND
      // the seen watermark — a malformed row is dropped, never rendered
      // half-true). Malformed timestamps degrade to epoch-zero strings so
      // the row still renders (the alert fact matters, the when is garnish).
      const banRows: unknown[] = Array.isArray(body?.banAlerts)
        ? body.banAlerts
        : [];
      const parsedBans: InboxBanAlert[] = [];
      banRows.forEach((row) => {
        if (typeof row !== 'object' || row === null) return;
        const { id, subscribedAt, notifiedAt } = row as {
          id?: unknown;
          subscribedAt?: unknown;
          notifiedAt?: unknown;
        };
        if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
          return;
        }
        if (typeof notifiedAt !== 'string' || notifiedAt.length === 0) return;
        parsedBans.push({
          id,
          subscribedAt:
            typeof subscribedAt === 'string' ? subscribedAt : notifiedAt,
          notifiedAt,
        });
      });
      setBanAlerts(parsedBans);
      // Ban seen-tracking: max-id watermark in localStorage (ids are
      // AUTOINCREMENT, strictly ordered). Opening the panel marks every
      // visible alert as seen; the mount fetch only counts past it.
      const seenMax = getBanSeenMax(steamId);
      const maxVisible = parsedBans.reduce(
        (max, alert) => Math.max(max, alert.id),
        0,
      );
      if (markVisibleAsSeen) {
        if (maxVisible > 0) setBanSeenMax(steamId, maxVisible);
        setBanUnread(0);
      } else {
        setBanUnread(
          parsedBans.filter((alert) => alert.id > seenMax).length,
        );
      }
      // Loop-guard token for this open: shape-checked (a malformed value
      // is never glued into a link). A null answer (occupied slot, mint
      // failure) must NOT evict a working token from a previous fetch:
      // reopening without clicking would otherwise downgrade live links
      // back to plain. Only a fresh valid token replaces. Resets
      // (identity switch, 401) still clear outright — see those call
      // sites, not here.
      const minted =
        typeof body?.antiLoopToken === 'string' &&
        isWatchTokenShape(body.antiLoopToken)
          ? body.antiLoopToken
          : null;
      setInboxToken((previous) => minted ?? previous);
      // Server count is exact past the row cap (30 delivered, 20 rows →
      // badge reads 30, not 20). The local filter is the fallback for a
      // malformed/absent server count only — same-version API always
      // sends it.
      const serverCount =
        typeof body?.unreadCount === 'number' &&
        Number.isInteger(body.unreadCount) &&
        body.unreadCount >= 0
          ? body.unreadCount
          : null;
      setUnreadCount(
        serverCount ??
          (countSince === null
            ? parsed.length
            : parsed.filter((item) => item.searchedAt > countSince).length),
      );
      // Monthly badge: server-owned when present, hidden otherwise (old
      // servers mid-rollout) — never guessed client-side.
      const serverMonthly =
        typeof body?.monthlyCount === 'number' &&
        Number.isInteger(body.monthlyCount) &&
        body.monthlyCount >= 0
          ? body.monthlyCount
          : null;
      setMonthlyCount(serverMonthly);
      if (markVisibleAsSeen) {
        const latest = latestSearchedAt(parsed);
        if (latest !== null) setLastSeenSearchedAt(steamId, latest);
        // The rows just opened are seen by definition, regardless of
        // what the count said a millisecond ago.
        setUnreadCount(0);
      }
    },
    [steamId],
  );

  const fetchNotifications = useCallback(
    async (markVisibleAsSeen: boolean): Promise<void> => {
      const seq = fetchSeqRef.current + 1;
      fetchSeqRef.current = seq;
      setLoading(true);
      setError(false);
      // Watermark read once per fetch: it is both the sinceSearchedAt
      // cursor sent to the server and the base of the local fallback count
      // below. Search-timestamp cursor (NOT any id): search ids embed
      // wall-clock plus randomness, so they are not strictly ordered.
      const rawWatermark = getLastSeenSearchedAt(steamId);
      // Validate watermark: if corrupted (not a parseable ISO timestamp),
      // clear it and proceed without a cursor to avoid a permanent 400 loop.
      const watermark =
        rawWatermark !== null && Number.isFinite(Date.parse(rawWatermark))
          ? rawWatermark
          : null;
      if (watermark !== rawWatermark && rawWatermark !== null) {
        // Watermark was corrupted — clear it so we don't retry with bad data.
        setLastSeenSearchedAt(steamId, null);
      }
      // The loop-guard token is only asked for when the fetched rows will
      // actually RENDER as links (panel open / retry = markVisibleAsSeen).
      // The mount fetch feeds just the bell badge — minting there would be
      // a blind UPDATE per page load against the unique index, plus a
      // wasted round trip delaying the badge, for links nobody sees.
      const tokenQuery = markVisibleAsSeen ? '&withToken=1' : '';
      try {
        let res = await fetch(
          `/api/watch/notifications?limit=${NOTIFICATIONS_LIMIT}${
            watermark === null
              ? ''
              : `&sinceSearchedAt=${encodeURIComponent(watermark)}`
          }${tokenQuery}`,
        );
        // A 400 here means a corrupt watermark slipped validation (or
        // raced it): clear it and retry once cursorless. The STATUS is
        // checked directly — never string-matched out of an error message.
        // The retry is cursorless, so the payload is applied with a null
        // cursor: keeping the invalidated watermark would corrupt the
        // local unread fallback (server counts always win, but the
        // fallback must still see the fetch as cursorless).
        let effectiveWatermark = watermark;
        if (res.status === 400 && watermark !== null) {
          setLastSeenSearchedAt(steamId, null);
          if (fetchSeqRef.current !== seq) return;
          res = await fetch(
            `/api/watch/notifications?limit=${NOTIFICATIONS_LIMIT}${tokenQuery}`,
          );
          effectiveWatermark = null;
        }
        if (fetchSeqRef.current !== seq) return;
        if (res.status === 401) {
          // Session died mid-use (logout elsewhere, expiry): drop the lane
          // state (stale rows + stale counts next to a login prompt would
          // lie) and offer the way back in. finally below clears loading.
          setSessionExpired(true);
          setNotifications([]);
          setUnreadCount(0);
          setBanAlerts([]);
          setBanUnread(0);
          setMonthlyCount(null);
          setInboxToken(null);
          return;
        }
        if (!res.ok) throw new Error(`notifications fetch: ${res.status}`);
        // A success clears a previous expiry: the session is demonstrably
        // alive again (re-login in another tab), so the login prompt must
        // not stick around next to fresh rows.
        setSessionExpired(false);
        const body = (await res.json().catch(() => null)) as {
          notifications?: unknown;
          unreadCount?: unknown;
          monthlyCount?: unknown;
          antiLoopToken?: unknown;
          banAlerts?: unknown;
        } | null;
        applyInboxPayload(body, markVisibleAsSeen, seq, effectiveWatermark);
        setError(false);
      } catch {
        if (fetchSeqRef.current !== seq) return;
        setError(true);
      } finally {
        if (fetchSeqRef.current === seq) setLoading(false);
      }
    },
    [steamId, applyInboxPayload],
  );

  // Fresh history per session id; a switch resets everything (never mix
  // profiles).
  useEffect(() => {
    setNotifications([]);
    setUnreadCount(0);
    setBanAlerts([]);
    setBanUnread(0);
    setRevealed({});
    setRevealing({});
    setRevealError({});
    setMonthlyCount(null);
    setInboxToken(null);
    setError(false);
    setSessionExpired(false);
    setOpen(false);
    fetchNotifications(false);
  }, [steamId, fetchNotifications]);

  const handleToggle = useCallback(() => {
    setOpen((wasOpen) => !wasOpen);
  }, []);

  // Ban reveal click: POSTs the opaque subscription id (never a target
  // steamId), logs server-side, and stores the disclosed target for the
  // link. One in-flight request per row; failures show a per-row retry,
  // never a panel-wide error.
  const handleReveal = useCallback(async (subscriptionId: number) => {
    setRevealing((prev) => ({ ...prev, [subscriptionId]: true }));
    setRevealError((prev) => ({ ...prev, [subscriptionId]: false }));
    try {
      const res = await fetch('/api/watch/ban-reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId }),
      });
      if (!res.ok) throw new Error(`ban reveal: ${res.status}`);
      const body = (await res.json().catch(() => null)) as {
        targetSteamId?: unknown;
      } | null;
      if (
        typeof body?.targetSteamId !== 'string' ||
        body.targetSteamId.length === 0
      ) {
        throw new Error('ban reveal: malformed response');
      }
      setRevealed((prev) => ({
        ...prev,
        [subscriptionId]: body.targetSteamId as string,
      }));
    } catch {
      setRevealError((prev) => ({ ...prev, [subscriptionId]: true }));
    } finally {
      setRevealing((prev) => ({ ...prev, [subscriptionId]: false }));
    }
  }, []);

  // Refetch on every open: cheap, and the only refresh path (no interval
  // polling by design). Visible rows mark as seen via the fetch itself.
  useEffect(() => {
    if (open) {
      fetchNotifications(true);
    }
  }, [open, fetchNotifications]);

  // Focus stewardship for keyboard users: into the panel on open, back to
  // the bell on close. Skipped on mount (both refs start closed).
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      headingRef.current?.focus();
    } else if (!open && prevOpenRef.current) {
      buttonRef.current?.focus();
    }
    prevOpenRef.current = open;
  }, [open]);

  // Escape closes (global keydown only while open); click-outside closes.
  // Deliberately a NON-modal popover (no aria-modal, no Tab trap): the
  // page behind stays usable, Escape/click-outside dismiss, and focus
  // stewardship above keeps keyboard users oriented.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent): void => {
      // containerRef wraps the bell AND the panel, so a single contains()
      // check covers both — no separate button comparison needed.
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const formatSearchedAt = useCallback(
    (searchedAt: string): string => {
      const ms = Date.parse(searchedAt);
      if (!Number.isFinite(ms)) return searchedAt;
      try {
        return dateFormatter.format(new Date(ms));
      } catch {
        return searchedAt;
      }
    },
    [dateFormatter],
  );

  // Panel body as early returns (no nested ternaries): expired sessions
  // first (login link, not silence), then loading only before the first
  // rows land; a later error keeps stale rows visible instead of swapping
  // them for an error screen.
  const renderPanelBody = (): React.ReactNode => {
    if (sessionExpired) {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-400">
            {translator('watchLoginError')}
          </p>
          <a
            href={`/api/auth/steam/login?next=${encodeURIComponent(resolveLoginNext(pathname, locale))}`}
            className="inline-block h-9 rounded-full border border-gray-500 px-4 text-sm leading-9 text-gray-200 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {translator('watchLoginButton')}
          </a>
        </div>
      );
    }
    if (loading && notifications.length === 0 && banAlerts.length === 0) {
      return (
        <p className="animate-pulse text-sm text-gray-400">
          {translator('watchInboxLoading')}
        </p>
      );
    }
    if (error && notifications.length === 0 && banAlerts.length === 0) {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-400">
            {translator('watchInboxError')}
          </p>
          <button
            type="button"
            onClick={() => fetchNotifications(true)}
            className="h-9 rounded-full border border-gray-500 px-4 text-sm text-gray-200 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {translator('watchInboxRetry')}
          </button>
        </div>
      );
    }
    // Ban-alert section first (newest alert first): generic copy + reveal.
    // The target link only renders AFTER the instrumented POST above —
    // the list payload never names the profile.
    const banSection =
      banAlerts.length === 0 ? null : (
        <ul className="mb-3 flex flex-col gap-3">
          {banAlerts.map((alert) => {
            const target = revealed[alert.id] ?? null;
            // Defense in depth (mirrors the backend's assertSteamId64): the
            // revealed id comes from our own API, but it is interpolated
            // into an href — a malformed value fails closed to the error
            // row instead of a crafted path. Unreachable in practice.
            const safeTarget =
              target !== null && isSteamId64(target) ? target : null;
            const busy = revealing[alert.id] === true;
            const failed =
              revealError[alert.id] === true || (target !== null && safeTarget === null);
            return (
              <li
                key={`ban-${alert.id}`}
                className="rounded-xl border border-red-500/40 p-3"
              >
                <p className="text-sm text-gray-200">
                  {translator('watchBanAlertBody')}
                </p>
                <time
                  dateTime={alert.notifiedAt}
                  className="mt-1 block text-xs font-bold text-purple-300"
                >
                  {formatSearchedAt(alert.notifiedAt)}
                </time>
                {safeTarget === null ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleReveal(alert.id)}
                    className="mt-2 h-8 rounded-full border border-red-400/60 px-3 text-sm text-red-200 hover:border-red-300 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                  >
                    {busy
                      ? translator('watchBanAlertLoading')
                      : translator('watchBanAlertReveal')}
                  </button>
                ) : (
                  <a
                    href={`/${locale}/player/${safeTarget}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block h-8 rounded-full border border-red-400/60 px-3 text-sm leading-8 text-red-200 hover:border-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  >
                    {translator('watchBanAlertOpen')}
                  </a>
                )}
                {failed && safeTarget === null && (
                  <p role="alert" className="mt-1 text-xs text-red-400">
                    {translator('watchBanAlertError')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      );
    if (notifications.length === 0) {
      return (
        <>
          {banSection}
          {banAlerts.length === 0 && (
            <p className="text-sm text-gray-400">
              {translator('watchInboxEmpty')}
            </p>
          )}
        </>
      );
    }
    return (
      <>
        {banSection}
        <ul className="flex flex-col gap-3">
          {notifications.map((item) => {
            // Country name, computed ONCE per row and shared by both the
            // in-sentence flag (tooltip/aria) and the visible origin text
            // below the timestamp. Visible origin exists because hover
            // tooltips do not exist on touch screens and several flags are
            // near-identical (Romania/Chad, Indonesia/Monaco); the bare
            // name needs no article in any locale, so it sidesteps the
            // gender/inflection problem the sentence avoids via the flag.
            const countryName =
              item.requesterCountry === null
                ? null
                : countryDisplayName(item.requesterCountry, locale);
            return (
              <li
                key={item.searchId}
                className="rounded-xl border border-gray-700 p-3"
              >
                <NotifyItemText
                  locale={locale}
                  steamId={steamId}
                  cheaterChecked={item.cheaterChecked}
                  searchedAt={item.searchedAt}
                  antiLoopToken={inboxToken}
                  requesterCountry={item.requesterCountry}
                  countryName={countryName}
                />
                {item.cheaterChecked && (
                  <p className="mt-1 text-sm text-lime-400">
                    {translator('watchInboxCheaterChecked')}
                  </p>
                )}
                {/* Viewed-at: when the reported search ran. Emphasized
                    (purple + bold) so the moment of the lookup reads at a
                    glance next to the sentence above. */}
                <time
                  dateTime={item.searchedAt}
                  className="mt-1 block text-xs font-bold text-purple-300"
                >
                  {formatSearchedAt(item.searchedAt)}
                  {countryName !== null && ` · ${countryName}`}
                </time>
              </li>
            );
          })}
        </ul>
      </>
    );
  };

  // One bell, one badge, for both streams (option (a)).
  const badgeCount = unreadCount + banUnread;

  return (
    <div
      data-testid="watch-inbox"
      ref={containerRef}
      className="relative inline-block"
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={translator('watchInboxBellLabel', { count: badgeCount })}
        className={`relative flex h-11 w-11 items-center justify-center rounded-full border-2 border-purple-500/50 bg-slate-900/20 text-white hover:border-purple-400/60 hover:bg-purple-600/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400${
          badgeCount > 0 ? ' shadow-[0_0_12px_rgba(168,85,247,0.35)]' : ''
        }`}
      >
        {/* Brand treatment (matches the avatar button + monthly badge):
            purple-bordered icon button on a dark slate tint with a filled
            bell — the old gray outline was the only neutral element in
            the navbar cluster. The red count badge keeps its universal
            unread meaning; the glow below only reinforces it while there
            is anything unseen. */}
        <svg
          aria-hidden="true"
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
        </svg>
        {badgeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white"
          >
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </button>

      {open && (
        <DropdownPanel
          ariaLabel={translator('watchInboxTitle')}
          // Brand scrollbar (the native gray one clashes with the dark +
          // purple panel): thin purple thumb on a transparent track.
          // WebKit needs the pseudo-element variants; Firefox uses the
          // two standard properties (same colors, no hover state there).
          scrollClassName="[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-purple-500/60 hover:[&::-webkit-scrollbar-thumb]:bg-purple-400 [scrollbar-width:thin] [scrollbar-color:#caafe4_transparent]"
          header={
            // Header row, never overlapping: the badge is a static flex
            // sibling (not absolute), so long locale strings (de) push the
            // title to wrap instead of running under the badge.
            <div className="flex items-start justify-between gap-2">
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="text-base font-semibold text-gray-100 focus:outline-none"
              >
                {translator('watchInboxTitle')}
              </h2>
              {monthlyCount !== null && (
                <span
                  aria-label={translator('watchInboxMonthlyBadge', {
                    count: monthlyCount,
                  })}
                  title={translator('watchInboxMonthlyBadge', {
                    count: monthlyCount,
                  })}
                  className="shrink-0 rounded-full border border-purple-500/50 bg-purple-600/20 px-2 py-0.5 text-[11px] font-semibold text-purple-200"
                >
                  {translator('watchInboxMonthlyBadge', { count: monthlyCount })}
                </span>
              )}
            </div>
          }
        >
          {/* Traveling margins (not scroller padding): the mt-3/mb-4 move
              WITH the items, so scrolling never paints rows over a fixed
              padding zone. Rest-state look matches the old p-4 exactly. */}
          <div className="mb-4 mt-3 min-h-24">{renderPanelBody()}</div>
        </DropdownPanel>
      )}
    </div>
  );
}

export default WatchInbox;

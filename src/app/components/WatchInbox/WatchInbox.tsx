'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { getNotifyText } from '@/lib/watch/notificationText';
import { WATCH_INBOX_DEFAULT_LIMIT } from '@/lib/watch/limits';
import {
  WATCH_IDENTITY_EVENT,
  getWatchIdentity,
} from '@/app/templates/Home/hooks/watch/watchIdentity';
import {
  getLastSeenSentAt,
  latestSentAt,
  setLastSeenSentAt,
} from '@/app/templates/Home/hooks/watch/watchReadState';

interface InboxNotification {
  id: number;
  sentAt: string;
}

const NOTIFICATIONS_LIMIT = WATCH_INBOX_DEFAULT_LIMIT;

/**
 * Watch inbox bell + dropdown (WB-14).
 *
 * Reads delivered notifies (kind='notify', status='sent') for the SteamID
 * stored by the Epic 4 identity flow and presents them newest-first. The
 * item text is the shared WB-15 base (same function family the bot sends
 * with). Language note: items render in the PAGE locale, while the bot
 * sent in the stored requester locale — same base text, viewer language.
 * If the user changes site language afterwards, the inbox wording can
 * legitimately differ from the Steam chat wording for the same event.
 * Only id + delivery timestamp travel over the API; text is composed
 * client-side from the base. By data-model design every item shares the
 * same base text and differs only by timestamp (no per-event content is
 * stored) — that is the intended look, not a rendering bug.
 *
 * Unread state is a local per-profile watermark (max delivered sent_at in
 * localStorage — no `read_at` column): opening the inbox marks everything
 * visible as seen. Timestamp (not id) cursor: retries keep old ids but land
 * fresh sent_at values. No interval polling by design (fetch on
 * mount/identity change, refetch on open and on manual retry only).
 *
 * Accessibility: real <button> with an interpolated aria-label (the count
 * never relies on color alone), aria-expanded, Escape closes, click-outside
 * closes, focus moves into the panel on open and back to the bell on
 * close, error/empty states are role="alert"/plain text (never silent).
 */
function WatchInbox() {
  const translator = useTranslations('Watch');
  // Page locale drives item language AND timestamp formatting (the bot may
  // have sent in the stored requester locale — same base text family).
  const locale = useLocale();
  const [identity, setIdentity] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const fetchSeqRef = useRef(0);

  // Identity lives in localStorage, which does not exist during SSR — read
  // it post-mount and render nothing until then to avoid a hydration
  // mismatch (same pattern as WatchManager). Two sync channels: the native
  // 'storage' event for OTHER tabs, and WATCH_IDENTITY_EVENT for this tab's
  // own writes (native storage events never fire in the writing document —
  // without the broadcast, a WatchManager submit on this page would leave
  // the bell hidden until reload).
  useEffect(() => {
    setIdentity(getWatchIdentity());
    setHydrated(true);
    const resync = (): void => {
      setIdentity(getWatchIdentity());
    };
    window.addEventListener('storage', resync);
    window.addEventListener(WATCH_IDENTITY_EVENT, resync);
    return () => {
      window.removeEventListener('storage', resync);
      window.removeEventListener(WATCH_IDENTITY_EVENT, resync);
    };
  }, []);

  const fetchNotifications = useCallback(
    async (steamId: string, markVisibleAsSeen: boolean): Promise<void> => {
      const seq = fetchSeqRef.current + 1;
      fetchSeqRef.current = seq;
      setLoading(true);
      setError(false);
      // Watermark read once per fetch: it is both the sinceSentAt cursor
      // sent to the server and the base of the local fallback count below.
      // Delivery-timestamp cursor (NOT max id): a requeued retry keeps its
      // old id but lands a fresh sent_at, so an id-cursor would skip a
      // late-delivered event that arrived after a newer id was seen.
      const watermark = getLastSeenSentAt(steamId);
      try {
        const res = await fetch(
          `/api/watch/notifications?steamId=${encodeURIComponent(steamId)}&limit=${NOTIFICATIONS_LIMIT}${
            watermark === null
              ? ''
              : `&sinceSentAt=${encodeURIComponent(watermark)}`
          }`,
        );
        if (!res.ok) throw new Error(`notifications fetch: ${res.status}`);
        const body = (await res.json().catch(() => null)) as {
          notifications?: unknown;
          unreadCount?: unknown;
        } | null;
        const rows: unknown[] = Array.isArray(body?.notifications)
          ? body.notifications
          : [];
        const parsed: InboxNotification[] = [];
        rows.forEach((row) => {
          if (typeof row !== 'object' || row === null) return;
          const { id, sentAt } = row as { id: unknown; sentAt: unknown };
          if (typeof id !== 'number' || !Number.isInteger(id)) return;
          if (typeof sentAt !== 'string') return;
          parsed.push({ id, sentAt });
        });
        // Stale-response guard: an identity switch mid-flight must not let
        // the previous profile's rows land in the new profile's inbox.
        if (fetchSeqRef.current !== seq) return;
        setNotifications(parsed);
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
            (watermark === null
              ? parsed.length
              : parsed.filter((item) => item.sentAt > watermark).length),
        );
        if (markVisibleAsSeen) {
          const latest = latestSentAt(parsed);
          if (latest !== null) setLastSeenSentAt(steamId, latest);
          // The rows just opened are seen by definition, regardless of
          // what the count said a millisecond ago.
          setUnreadCount(0);
        }
      } catch {
        if (fetchSeqRef.current !== seq) return;
        setError(true);
      } finally {
        if (fetchSeqRef.current === seq) setLoading(false);
      }
    },
    [],
  );

  // Fresh history per identity; a switch resets everything (never mix
  // profiles) and skips invalid/absent ids entirely (no fetch at all).
  useEffect(() => {
    setNotifications([]);
    setUnreadCount(0);
    setError(false);
    setOpen(false);
    if (identity === null) {
      return;
    }
    fetchNotifications(identity, false);
  }, [identity, fetchNotifications]);

  const handleToggle = useCallback(() => {
    setOpen((wasOpen) => !wasOpen);
  }, []);

  // Refetch on every open: cheap, and the only refresh path (no interval
  // polling by design). Visible rows mark as seen via the fetch itself.
  useEffect(() => {
    if (open && identity !== null) {
      fetchNotifications(identity, true);
    }
  }, [open, identity, fetchNotifications]);

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

  const formatSentAt = useCallback(
    (sentAt: string): string => {
      const ms = Date.parse(sentAt);
      if (!Number.isFinite(ms)) return sentAt;
      try {
        return dateFormatter.format(new Date(ms));
      } catch {
        return sentAt;
      }
    },
    [dateFormatter],
  );

  if (!hydrated || identity === null) {
    // No identity, no inbox: never fetch without a valid SteamID.
    return null;
  }

  // Panel body as early returns (no nested ternaries): loading only
  // matters before the first rows land; a later error keeps stale rows
  // visible instead of swapping them for an error screen. Defined after
  // the identity guard so `identity` is narrowed to string here.
  const renderPanelBody = (): React.ReactNode => {
    if (loading && notifications.length === 0) {
      return (
        <p className="animate-pulse text-sm text-gray-400">
          {translator('watchInboxLoading')}
        </p>
      );
    }
    if (error && notifications.length === 0) {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-400">
            {translator('watchInboxError')}
          </p>
          <button
            type="button"
            onClick={() => fetchNotifications(identity, true)}
            className="h-9 rounded-full border border-gray-500 px-4 text-sm text-gray-200 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {translator('watchInboxRetry')}
          </button>
        </div>
      );
    }
    if (notifications.length === 0) {
      return (
        <p className="text-sm text-gray-400">{translator('watchInboxEmpty')}</p>
      );
    }
    return (
      <ul className="flex flex-col gap-3">
        {notifications.map((item) => (
          <li key={item.id} className="rounded-xl border border-gray-700 p-3">
            <p className="text-sm text-gray-200">
              {getNotifyText(locale, identity)}
            </p>
            <time
              dateTime={item.sentAt}
              className="mt-1 block text-xs text-gray-400"
            >
              {formatSentAt(item.sentAt)}
            </time>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={translator('watchInboxBellLabel', { count: unreadCount })}
        className="relative flex h-11 w-11 items-center justify-center rounded-full border border-gray-500 text-gray-200 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-purple-600 px-1 text-[11px] font-bold text-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={translator('watchInboxTitle')}
          className="absolute right-0 z-50 mt-2 max-h-96 w-80 max-w-[90vw] overflow-y-auto rounded-2xl border border-gray-600 bg-gray-900 p-4 shadow-xl"
        >
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold text-gray-100 focus:outline-none"
          >
            {translator('watchInboxTitle')}
          </h2>
          <div className="mt-3 min-h-24">{renderPanelBody()}</div>
        </div>
      )}
    </div>
  );
}

export default WatchInbox;

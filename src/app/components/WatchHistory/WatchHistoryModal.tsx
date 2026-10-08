'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import Portal from '@/app/components/Portal';
import { Link, usePathname } from '@/navigation';
import { isSteamId64 } from '@/lib/steamId';
import type { SearcherHistoryEntry } from '@/lib/analytics/types';
import { HISTORY_PAGE_SIZE } from '@/lib/analytics/historyLimits';
import {
  pendingPollDelay,
  RECONNECT_WAIT_CAP_MS,
} from '@/lib/watch/pendingPolicy';
import resolveLoginNext from '@/lib/watch/loginNext';
import { recordLoginCta } from '@/app/templates/Home/shared/analytics/loginFunnel';

interface WatchHistoryModalProps {
  onClose: () => void;
}

type LoadStatus = 'loading' | 'loaded' | 'unauthorized' | 'error';

/**
 * Inline "load more" failure: 'load' (transient read failure — rows stay,
 * retry inline) vs 'expired' (the session died mid-paging — rows stay,
 * sign in again inline). Never a full-panel swap: once a row is on
 * screen it stays (the docstring promise below).
 */
type AppendError = 'load' | 'expired' | null;

// The confirm arm auto-disarms after this long: an armed-forever button
// would let a later accidental tap execute a deletion.
const CLEAR_CONFIRM_ARMED_MS = 4000;
// A fast double-tap (double-click speed) arms AND executes before the
// user can read the confirm label. The second tap inside this window
// is treated as the same accidental gesture, not consent.
const CLEAR_CONFIRM_MIN_MS = 400;

// Module-scoped scroll-lock refcount (see the effect below): two
// stacked modals share one <html> class — and the saved overflow
// belongs to the OUTERMOST lock, not to each instance (restoring a
// middle instance's snapshot would unlock under the one still open).
let modalScrollLocks = 0;
let modalSavedOverflow: string | null = null;

const formatWhen = (iso: string, locale: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(locale);
};

/**
 * "My search history" modal: every profile the logged-in viewer looked
 * up, newest first, appended page by page. Rendered through <Portal> so
 * the fixed overlay never inherits the dropdown's stacking context. Data
 * comes EXCLUSIVELY from GET /api/history (session cookie — the component
 * never sends an id and never reads another user's rows). Same dismiss
 * contract as the other modals: X button + Escape, focus into the title
 * on open.
 *
 * Paging appends (never wipes the list into a spinner): once a row is on
 * screen it stays, even while the next page loads or a "load more" fails
 * (the failure renders inline next to the button, with the rows intact).
 * In-flight fetches are aborted on unmount and superseded on retry, so a
 * late response can never overwrite newer state. The next-page bookmark
 * is server-built (nextCursor, passed back opaquely) — the client never
 * constructs the cursor format.
 *
 * Paused state (opt-out with a surviving session): shows the reconnect
 * CTA — it opens the bot profile in a new tab and polls
 * /api/history/reconnect (pendingPolicy cadence) until the bot's
 * accept lets the server recreate the attribution anchor; done reloads
 * page one so the SERVER's attributing flag drives the un-pause (no
 * optimistic client flip). Scope note: that lane resumes history only —
 * notifications stay off until the user Starts a watch themselves.
 */
function WatchHistoryModal({ onClose }: WatchHistoryModalProps) {
  const translator = useTranslations('Watch');
  const feedbackTranslator = useTranslations('feedback');
  const locale = useLocale();
  const pathname = usePathname();
  const loginNext = resolveLoginNext(pathname, locale);
  const [entries, setEntries] = useState<SearcherHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Whether new searches are being attributed to this session (false =
  // opted-out with a surviving cookie: the empty state must say so,
  // not promise recordings that never come). True until proven
  // otherwise — the loading spinner covers the unknown window.
  const [attributing, setAttributing] = useState(true);
  // Bot-profile link for the paused state's reconnect CTA (first page
  // only, alongside attributing — null when attributing, when the env
  // lacks STEAM_BOT_STEAMID, and on later pages).
  const [botProfileUrl, setBotProfileUrl] = useState<string | null>(null);
  // Reconnect wait (paused state only): the CTA opened the bot profile
  // and the poll lane below completes the resume when the bot accepts.
  const [reconnecting, setReconnecting] = useState(false);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [appendError, setAppendError] = useState<AppendError>(null);
  const [clearError, setClearError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clearArmedAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Callback ref (not a mount effect): the Portal renders null on the
  // first commit and only mounts the dialog on the second, so an effect
  // would run while the title does not exist yet and focus nothing.
  // Focusing on attach fires exactly when the node lands in the DOM.
  const focusTitle = useCallback((node: HTMLHeadingElement | null) => {
    node?.focus();
  }, []);
  // Mirrors for values read inside in-flight callbacks (state captured by
  // a pending load would be stale by construction).
  const entriesRef = useRef<SearcherHistoryEntry[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const applyPage = useCallback(
    (
      page: SearcherHistoryEntry[],
      nextCursor: string | null,
      totalCount: number | null,
      pageAttributing: boolean | null,
      pageBotProfileUrl: string | null,
      append: boolean,
    ) => {
      const next = append ? [...entriesRef.current, ...page] : page;
      entriesRef.current = next;
      nextCursorRef.current = nextCursor;
      setEntries(next);
      setHasMore(nextCursor !== null);
      // The footprint + CTA link ship on the first page only (later
      // pages carry null): keep the first-page values, like total.
      if (typeof pageAttributing === 'boolean') {
        setAttributing(pageAttributing);
        setBotProfileUrl(pageBotProfileUrl);
        // Resume landed through another lane while this wait was open
        // (login elsewhere, bot accepted before the poll saw it): the
        // wait is over even though no poll answered done.
        if (pageAttributing) setReconnecting(false);
      }
      // The total ships on the first page only (later pages carry null):
      // keep the first-page count for the "showing N of M" note.
      if (typeof totalCount === 'number') setTotal(totalCount);
      setAppendError(null);
      setStatus('loaded');
    },
    [],
  );

  const load = useCallback(
    async (append: boolean) => {
      // Defensive (unreachable while hasMore drives the button, which
      // mirrors nextCursor): appending past exhaustion would re-fetch
      // page one and duplicate rows under duplicate keys.
      if (append && nextCursorRef.current === null && entriesRef.current.length > 0) {
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (append) {
        setLoadingMore(true);
        setAppendError(null);
      } else {
        setStatus('loading');
      }
      try {
        const params = new URLSearchParams({
          limit: String(HISTORY_PAGE_SIZE),
        });
        // Server-built bookmark from the previous page (never constructed
        // here — the format lives in exactly one place, the DAL).
        if (append && nextCursorRef.current !== null) {
          params.set('cursor', nextCursorRef.current);
        }
        const res = await fetch(`/api/history?${params.toString()}`, {
          signal: controller.signal,
        });
        if (res.status === 401) {
          // First page: full gate. Append: session died mid-paging —
          // rows stay, sign-in renders inline (never a list wipe).
          if (append) {
            setAppendError('expired');
          } else {
            setStatus('unauthorized');
          }
          return;
        }
        if (!res.ok) {
          if (append) {
            setAppendError('load');
          } else {
            setStatus('error');
          }
          return;
        }
        const body = await res.json();
        const page: SearcherHistoryEntry[] = Array.isArray(body.entries)
          ? body.entries
          : [];
        applyPage(
          page,
          typeof body.nextCursor === 'string' ? body.nextCursor : null,
          typeof body.total === 'number' ? body.total : null,
          typeof body.attributing === 'boolean' ? body.attributing : null,
          typeof body.botProfileUrl === 'string' ? body.botProfileUrl : null,
          append,
        );
      } catch (error) {
        // Superseded/unmounted fetches die here by design — never an
        // error state for a response nobody is waiting for.
        if (error instanceof Error && error.name === 'AbortError') return;
        if (append) {
          setAppendError('load');
        } else {
          setStatus('error');
        }
      } finally {
        // Identity guard: a superseded request (aborted by retry/clear/
        // unmount) must not clear the spinner of the request that
        // replaced it.
        if (abortRef.current === controller) setLoadingMore(false);
      }
    },
    [applyPage],
  );

  useEffect(() => {
    load(false).catch(() => undefined);
    return () => abortRef.current?.abort();
  }, [load, reloadToken]);

  // Reconnect wait (paused state): the CTA opened the bot profile, now
  // poll until the bot accepts. Mirrors the PendingLoginRoom discipline
  // (single source: pendingPolicy owns the cadence; one GetFriendList
  // read per tick against the shared Steam quota): immediate first hit
  // (the accept may have landed before the click), hidden tabs skip the
  // fetch and re-poll on return to foreground, single-flight guards a
  // visibility ping against a fetch already in flight, network blips
  // keep waiting (only done flips the state — and 401 hands over to
  // the session-expired gate, the honest answer once the cookie died
  // mid-wait). Unmount/close stops the loop: reopening re-reads page
  // one, and the footprint fast path answers instantly if the accept
  // landed meanwhile. StrictMode's remount only restarts it (idempotent
  // GET, convergent completion).
  useEffect(() => {
    if (!reconnecting) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let scheduledWaits = 0;
    const startedAt = Date.now();
    const poll = async (): Promise<void> => {
      // Next wait on the shared tier schedule (see pendingPolicy). Nested
      // (not sibling) on purpose: a sibling helper referencing `poll`
      // trips no-use-before-define, while everything inside `poll`'s own
      // body sits textually after its declaration.
      const scheduleNext = (): void => {
        if (cancelled) return;
        // Duration cap (parity with the login room's 30-min pending
        // TTL): a forgotten foreground tab must not poll GetFriendList
        // forever. Flipping back to idle re-shows the CTA below — the
        // click restarts the wait, no dead-end state.
        if (Date.now() - startedAt >= RECONNECT_WAIT_CAP_MS) {
          setReconnecting(false);
          return;
        }
        const delay = pendingPollDelay(scheduledWaits);
        scheduledWaits += 1;
        timer = setTimeout(() => {
          poll();
        }, delay);
      };
      // Single-flight: a visibility ping landing while a fetch is still
      // outstanding skips instead of doubling it (the owner converges).
      if (inFlight) return;
      // Hidden tab: no fetch (shared Steam quota is not spent on an
      // unseen screen), just stay on schedule — the visibility listener
      // below fires an immediate poll on return.
      if (document.visibilityState === 'hidden') {
        scheduleNext();
        return;
      }
      inFlight = true;
      try {
        const params = new URLSearchParams({ locale });
        const res = await fetch(`/api/history/reconnect?${params.toString()}`, {
          method: 'GET',
        });
        if (cancelled) return;
        if (res.status === 401) {
          // The session died mid-wait: the history itself is gone, the
          // sign-in gate is the honest rendering (page-preserving link,
          // same as every expired-session surface here).
          setReconnecting(false);
          setStatus('unauthorized');
          return;
        }
        if (!res.ok) {
          // 429/500/blip: keep waiting, retry next tick.
          scheduleNext();
          return;
        }
        const body = await res.json().catch(() => null);
        if (cancelled || body === null || body.done !== true) {
          scheduleNext();
          return;
        }
        // Resumed: reload page one — the server-driven attributing flag
        // flips the paused branch off (single source of truth, no
        // optimistic client-side flip that a race could contradict).
        setReconnecting(false);
        setReloadToken((token) => token + 1);
      } catch {
        // Network blip mid-wait: retry next tick, only `done` ends it.
        scheduleNext();
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `locale` is a stable next-intl primitive for the modal's lifetime
    // (same value the login link already reads); re-running on an
    // identity change would only restart a healthy wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnecting, locale]);

  // CTA: opens the bot profile (real navigation — the user must add the
  // bot on Steam's side) and starts the poll above. The anchor keeps
  // default behavior (no preventDefault): the modal stays open under
  // the new tab, so the wait starts without any state juggling.
  const handleReconnectClick = useCallback(() => {
    setReconnecting(true);
  }, []);

  // Scroll lock: the page behind a modal must not scroll (the modal has
  // its own scroller). Restored on unmount — no global leakage. The
  // scrollbar gutter is scoped to a <html> class (not a global rule):
  // reserving it site-wide would shift every short page — and the class
  // is only added when the page actually scrolls, so short pages never
  // reserve space they don't need. Ref-counted: if a second modal
  // locks while this one is open, the first unmount must not drop the
  // class from under it.
  useEffect(() => {
    if (modalScrollLocks === 0) {
      modalSavedOverflow = document.body.style.overflow;
    }
    modalScrollLocks += 1;
    document.body.style.overflow = 'hidden';
    const pageScrolls =
      document.documentElement.scrollHeight >
      document.documentElement.clientHeight;
    if (pageScrolls) {
      document.documentElement.classList.add('modal-open');
    }
    return () => {
      modalScrollLocks = Math.max(0, modalScrollLocks - 1);
      if (modalScrollLocks === 0) {
        document.body.style.overflow = modalSavedOverflow ?? '';
        modalSavedOverflow = null;
        document.documentElement.classList.remove('modal-open');
      }
    };
  }, []);

  // Armed-confirm auto-disarm (see CLEAR_CONFIRM_ARMED_MS).
  useEffect(() => {
    if (!confirmingClear) return undefined;
    const timer = setTimeout(
      () => setConfirmingClear(false),
      CLEAR_CONFIRM_ARMED_MS,
    );
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.repeat) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const handleLoginClick = useCallback(() => {
    // Fire-and-forget CTA beacon (never awaited, never preventDefaulted):
    // same pattern as WatchManager — the funnel must attribute this
    // sign-in to the history gate, not lose it.
    recordLoginCta();
  }, []);

  const handleClear = useCallback(async () => {
    if (!confirmingClear) {
      // Two-step destructive action (no native confirm() — untestable
      // and unstyled): first tap arms, second executes.
      setConfirmingClear(true);
      clearArmedAtRef.current = Date.now();
      return;
    }
    if (Date.now() - clearArmedAtRef.current < CLEAR_CONFIRM_MIN_MS) {
      // Same accidental gesture (double-tap), not a read confirmation.
      return;
    }
    setConfirmingClear(false);
    // Abort any in-flight page first: its late response would otherwise
    // repopulate the list with rows the server just de-attributed
    // (clear × load-more race).
    abortRef.current?.abort();
    setClearing(true);
    setClearError(false);
    try {
      const res = await fetch('/api/history', { method: 'DELETE' });
      if (res.status === 401) {
        // Dead session: the rows shown belong to it, and every further
        // action needs a login — full gate (with the page-preserving
        // link), not the generic clear error.
        setStatus('unauthorized');
        return;
      }
      if (!res.ok) {
        // Own message (not the load error): the failure was a DELETE,
        // and the rows are still saved — say exactly that.
        setClearError(true);
        return;
      }
      entriesRef.current = [];
      nextCursorRef.current = null;
      setEntries([]);
      setHasMore(false);
      setTotal(0);
      setStatus('loaded');
    } catch {
      setClearError(true);
    } finally {
      setClearing(false);
    }
  }, [confirmingClear]);

  const loginHref = `/api/auth/steam/login?next=${encodeURIComponent(loginNext)}`;

  return (
    <Portal>
      {/* Centered both ways with a FIXED height: a growing centered
          dialog would re-center on every page load (real CLS), so the
          dialog never grows — the list scrolls inside it instead. */}
      <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="watch-history-title"
          className="relative my-auto flex h-[min(32rem,84dvh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-purple-400/60 bg-[#1c1c28] px-6 pb-4 pt-6 shadow-[0_0_50px_rgba(168,85,247,0.35)]"
        >
          <button
            onClick={onClose}
            type="button"
            aria-label={feedbackTranslator('close')}
            className="absolute right-1 top-0 p-2 text-3xl text-purple-300 hover:text-purple-500 md:text-4xl"
          >
            ×
          </button>
          <h2
            id="watch-history-title"
            ref={focusTitle}
            tabIndex={-1}
            className="mb-1 text-center text-2xl font-extrabold tracking-tight text-gray-100 focus:outline-none"
          >
            {translator('watchHistoryTitle')}
          </h2>
          {/* Always reserved (even before load): the late-appearing line
              used to push the list down mid-read (CLS inside the modal). */}
          <p className="mb-3 h-4 text-center text-xs text-gray-400">
            {status === 'loaded' && attributing
              ? translator('watchHistoryShowing', {
                  shown: entries.length,
                  total,
                })
              : ' '}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {status === 'loading' && (
              <p
                role="status"
                className="py-8 text-center text-sm text-gray-400"
              >
                {translator('watchHistoryLoading')}
              </p>
            )}
            {status === 'unauthorized' && (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-gray-300">
                  {translator('watchHistorySessionExpired')}
                </p>
                <a
                  href={loginHref}
                  onClick={handleLoginClick}
                  className="rounded-full bg-purple-600 px-6 py-2 text-sm font-semibold text-white hover:bg-purple-700/90"
                >
                  {translator('watchLoginButton')}
                </a>
              </div>
            )}
            {status === 'error' && (
              <div
                role="alert"
                className="flex flex-col items-center gap-3 py-8 text-center"
              >
                <p className="text-sm text-gray-300">
                  {translator('watchHistoryError')}
                </p>
                <button
                  type="button"
                  onClick={() => setReloadToken((token) => token + 1)}
                  className="rounded-full border border-gray-500 px-6 py-2 text-sm text-gray-300 hover:border-gray-300"
                >
                  {translator('watchHistoryRetry')}
                </button>
              </div>
            )}
            {status === 'loaded' && !attributing && (
              // Paused (not cleared): unfriending hides the history until
              // the user re-adds the bot — the links themselves persist
              // and resurface together with new searches. TWO truthful
              // copies, keyed on whether hidden rows exist: rows present
              // → "your searches are hidden"; none (never had any, or a
              // Clear just de-attributed them) → the empty copy says
              // only what is real — nothing saved here, and new ones
              // stay paused. No live-region on the wrapper: the waiting
              // <p> below is the only changing content anouncee (a
              // status role over the CTA would read the whole link out
              // on every change).
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-gray-400">
                  {translator(
                    entries.length > 0
                      ? 'watchHistoryPausedNote'
                      : 'watchHistoryEmptyOptedOut',
                  )}
                </p>
                {botProfileUrl !== null && (
                  <a
                    href={botProfileUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={handleReconnectClick}
                    className="rounded-full bg-purple-600 px-6 py-2 text-sm font-semibold text-white hover:bg-purple-700/90"
                  >
                    {translator('watchHistoryReconnectCta')}
                  </a>
                )}
                {/* The CTA STAYS during the wait (on purpose): if the
                    popup was blocked, the tab got closed, or Steam
                    failed to open, "Waiting…" alone would be a dead end
                    — the still-visible link is the retry affordance,
                    and it also re-arms after the duration cap below. */}
                {reconnecting && (
                  <p role="status" className="text-xs text-gray-400">
                    {translator('watchHistoryReconnectWaiting')}
                  </p>
                )}
              </div>
            )}
            {status === 'loaded' &&
              attributing &&
              (entries.length === 0 ? (
                <p
                  role="status"
                  className="py-8 text-center text-sm text-gray-400"
                >
                  {translator('watchHistoryEmpty')}
                </p>
              ) : (
                <>
                  <ul className="space-y-2">
                    {entries.map((entry) => (
                      <li
                        key={entry.searchId}
                        className="flex items-center justify-between gap-3 rounded-lg border border-purple-500/20 bg-white/[0.04] px-3 py-2"
                      >
                        {isSteamId64(entry.steamId) ? (
                          <Link
                            href={`/player/${entry.steamId}`}
                            onClick={onClose}
                            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-purple-100 hover:underline"
                          >
                            {entry.nickname || entry.steamId}
                          </Link>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-purple-100">
                            {entry.nickname || entry.steamId}
                          </span>
                        )}
                        <span className="flex shrink-0 flex-col items-end text-xs text-gray-400">
                          <span>{formatWhen(entry.searchedAt, locale)}</span>
                          {entry.cheaterChecked && (
                            <span className="text-amber-300">
                              {translator('watchInboxCheaterChecked')}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {appendError !== null && (
                    <div
                      role="alert"
                      className="flex flex-col items-center gap-2 py-3 text-center"
                    >
                      <p className="text-xs text-gray-400">
                        {translator(
                          appendError === 'expired'
                            ? 'watchHistorySessionExpired'
                            : 'watchHistoryError',
                        )}
                      </p>
                      {appendError === 'expired' ? (
                        <a
                          href={loginHref}
                          onClick={handleLoginClick}
                          className="rounded-full bg-purple-600 px-6 py-2 text-sm font-semibold text-white hover:bg-purple-700/90"
                        >
                          {translator('watchLoginButton')}
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => load(true)}
                          disabled={loadingMore}
                          className="rounded-full border border-gray-500 px-6 py-2 text-sm text-gray-300 hover:border-gray-300 disabled:opacity-50"
                        >
                          {translator('watchHistoryRetry')}
                        </button>
                      )}
                    </div>
                  )}
                  {hasMore && appendError === null && (
                    <div className="flex justify-center py-3">
                      <button
                        type="button"
                        onClick={() => load(true)}
                        disabled={loadingMore}
                        className="rounded-full border border-gray-500 px-6 py-2 text-sm text-gray-300 hover:border-gray-300 disabled:opacity-50"
                      >
                        {loadingMore
                          ? translator('watchHistoryLoading')
                          : translator('watchHistoryLoadMore')}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
          {/* Footer, pinned to the dialog bottom (outside the scroller):
              the destructive action and its disclosure never scroll away
              and never move when pages append. */}
          {status === 'loaded' && (
            <div className="border-t border-purple-500/20 pt-3">
              {clearError && entries.length > 0 && (
                <p
                  role="alert"
                  className="pb-1 text-center text-xs text-red-400"
                >
                  {translator('watchHistoryClearError')}
                </p>
              )}
              {/* Clear runs in BOTH the listed and the paused state: the
                  rows are the viewer's own and stay reachable through
                  the session for ≤30 days after an unfriend — past that
                  window, only the TTL can cut them. Gating the erase on
                  attributing would strip the paused viewer of the only
                  deletion handle they get (deletion is not display).
                  DELETE needs no footprint, just the sealed session. */}
              {entries.length > 0 && (
                <div
                  className="flex justify-center pb-1"
                  aria-live="polite"
                >
                  <button
                    type="button"
                    onClick={handleClear}
                    disabled={clearing}
                    className="text-xs text-gray-400 underline hover:text-gray-300 disabled:opacity-50"
                  >
                    {confirmingClear
                      ? translator('watchHistoryClearConfirm')
                      : translator('watchHistoryClear')}
                  </button>
                </div>
              )}
              {/* Unfriend-hides-history disclosure (product decision):
                  unfriending pauses (never deletes) — entries resurface
                  on re-add, so the loss is never silent. gray-400 keeps
                  the disclosure above 4.5:1 on the dialog background
                  (gray-500 reads ~3.7:1 there). */}
              <p className="pb-1 text-center text-[11px] leading-snug text-gray-400">
                {translator('watchHistoryOptOutNote')}
              </p>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

export default WatchHistoryModal;

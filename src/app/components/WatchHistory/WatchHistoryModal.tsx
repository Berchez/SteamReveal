'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import Portal from '@/app/components/Portal';
import { Link, usePathname } from '@/navigation';
import { isSteamId64 } from '@/lib/steamId';
import type { SearcherHistoryEntry } from '@/lib/analytics/types';
import { HISTORY_PAGE_SIZE } from '@/lib/analytics/historyLimits';
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
      append: boolean,
    ) => {
      const next = append ? [...entriesRef.current, ...page] : page;
      entriesRef.current = next;
      nextCursorRef.current = nextCursor;
      setEntries(next);
      setHasMore(nextCursor !== null);
      // The footprint ships on the first page only (later pages carry
      // null): keep the first-page value, like total.
      if (typeof pageAttributing === 'boolean') {
        setAttributing(pageAttributing);
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
      {/* Top-anchored (items-start), NOT centered: the dialog grows from
          min-h toward max-h as pages land, and a centered dialog would
          re-center on every growth — moving title, close button and
          counts minutes after the click (real CLS). Anchored, growth
          extends downward and nothing already painted moves. */}
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="watch-history-title"
          className="relative mb-4 mt-[8dvh] flex max-h-[90dvh] min-h-[min(28rem,90dvh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-purple-400/60 bg-[#1c1c28] px-6 pb-4 pt-6 shadow-[0_0_50px_rgba(168,85,247,0.35)]"
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
            {status === 'loaded'
              ? translator('watchHistoryShowing', {
                  shown: entries.length,
                  total,
                })
              : ' '}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {status === 'loaded' && (
              // Collection disclosure at the point of the feature (the
              // LoginPrompt line only reaches pre-login users — logged-in
              // viewers meet this notice instead): what is stored, how
              // long, how to erase.
              <p className="mb-2 text-center text-[11px] leading-snug text-gray-500">
                {translator('watchHistoryPrivacyNote')}
              </p>
            )}
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
            {status === 'loaded' &&
              (entries.length === 0 ? (
                <p
                  role="status"
                  className="py-8 text-center text-sm text-gray-400"
                >
                  {translator(
                    attributing
                      ? 'watchHistoryEmpty'
                      : 'watchHistoryEmptyOptedOut',
                  )}
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
                  {clearError && (
                    <p
                      role="alert"
                      className="pb-1 text-center text-xs text-red-400"
                    >
                      {translator('watchHistoryClearError')}
                    </p>
                  )}
                  <div
                    className="flex justify-center pb-1"
                    aria-live="polite"
                  >
                    <button
                      type="button"
                      onClick={handleClear}
                      disabled={clearing}
                      className="text-xs text-gray-500 underline hover:text-gray-300 disabled:opacity-50"
                    >
                      {confirmingClear
                        ? translator('watchHistoryClearConfirm')
                        : translator('watchHistoryClear')}
                    </button>
                  </div>
                </>
              ))}
            {/* Opt-out coupling, disclosed where history is managed (also
                on the empty state — it explains a mysteriously empty
                history): unfriending the bot (leaving Watch) also cuts
                these links — no silent data loss. Kept coupled by product
                decision (opt-out means "no record survives"). */}
            {status === 'loaded' && (
              <p className="pb-1 text-center text-[11px] leading-snug text-gray-500">
                {translator('watchHistoryOptOutNote')}
              </p>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default WatchHistoryModal;

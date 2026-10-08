'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useTranslations } from 'next-intl';

import DropdownPanel from '@/app/components/DropdownPanel/DropdownPanel';
import WatchManager from '@/app/components/WatchManager';
import {
  prefetchWatchStatus,
  type WarmWatchStatusSnapshot,
} from '@/app/templates/Home/hooks/watch/watchStatusPrefetch';

// The history modal rides OUTSIDE the navbar chunk: it renders only after
// a click, so it loads on demand (same laziness rationale as the status
// prefetch below — FCP/LCP never observe it). Hover/focus on the history
// button warms the import in the intent→click gap.
const WatchHistoryModal = dynamic(
  () => import('@/app/components/WatchHistory'),
  { ssr: false },
);

interface SiteNavMenuProps {
  steamId: string;
  nickname: string;
  avatarUrl: string | null;
  avatarAlt: string;
  /** Server-seeded first paint (null = cold open, skeleton path). */
  initialWatch?: WarmWatchStatusSnapshot | null;
}

/**
 * Avatar image-or-initial badge shared by the menu button and the panel
 * header: one fallback definition (letter of the nickname, emoji-safe),
 * two sizes.
 */
function AvatarBadge({
  avatarUrl,
  initial,
  size,
}: {
  avatarUrl: string | null;
  initial: string;
  size: 'button' | 'header';
}) {
  const dimension = size === 'button' ? 'h-11 w-11' : 'h-8 w-8';
  // A CDN hiccup (or a future Steam avatar-host migration the allowlist
  // — pinned by next.config.test.ts — doesn't cover yet) must degrade to
  // the letter initial, never to a broken image in the navbar.
  const [imgFailed, setImgFailed] = useState(false);
  if (avatarUrl !== null && !imgFailed) {
    return (
      <Image
        src={avatarUrl}
        alt=""
        width={size === 'button' ? 44 : 32}
        height={size === 'button' ? 44 : 32}
        className={`${dimension} rounded-full object-cover`}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex ${dimension} items-center justify-center rounded-full font-bold ${
        size === 'button'
          ? 'text-lg text-gray-200'
          : 'bg-purple-600 text-sm text-white'
      }`}
    >
      {initial}
    </span>
  );
}

/**
 * Logged-in navbar menu: avatar button + dropdown panel. The panel reuses
 * WatchManager as its content (same states, same polling, same logout) in
 * a constrained width — one flow definition, one surface.
 *
 * Same dismiss/a11y contract as WatchInbox and LanguageSwitcher: Escape
 * closes, click-outside closes, focus moves into the panel on open and
 * back to the button on close. Deliberately a NON-modal popover (no
 * aria-modal, no Tab trap — same rationale as WatchInbox): the page
 * behind stays usable.
 */
function SiteNavMenu({
  steamId,
  nickname,
  avatarUrl,
  avatarAlt,
  initialWatch = null,
}: SiteNavMenuProps) {
  const watchTranslator = useTranslations('Watch');
  const [open, setOpen] = useState(false);
  // Search-history modal state lives HERE (not in WatchManager): the
  // modal is portaled to document.body, so a click inside it counts as
  // "outside" for the dropdown's click-outside handler below. Owning it
  // here lets opening the modal close the dropdown first — the modal then
  // survives on its own (no unmount mid-interaction, no remount when the
  // watch poll flips) and closing it refocuses the avatar button.
  const [historyOpen, setHistoryOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLParagraphElement | null>(null);
  const prevOpenRef = useRef(false);
  // Mirror for the focus effect below: when the dropdown closes BECAUSE
  // the history modal opened, focus must go to the modal title (its own
  // mount effect), not back to the avatar button — otherwise the two
  // effects fight and the button (behind the modal) wins. Updated in the
  // open/close handlers (never during render — concurrent-safe).
  const historyOpenRef = useRef(false);

  const handleToggle = () => {
    setOpen((wasOpen) => !wasOpen);
  };

  const handleOpenHistory = useCallback(() => {
    historyOpenRef.current = true;
    setOpen(false);
    setHistoryOpen(true);
  }, []);

  const handleCloseHistory = useCallback(() => {
    historyOpenRef.current = false;
    setHistoryOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Warms the history-modal chunk in the hover→click gap (pairs with the
  // dynamic() import above). Fire-and-forget: the import cache dedupes,
  // a rejection just means a cold click (same .catch pattern as the
  // modal's own initial load).
  const handleHistoryPrefetchIntent = useCallback(() => {
    import('@/app/components/WatchHistory').catch(() => undefined);
  }, []);

  // Warms the watch-status cache in the hover→click gap so the panel often
  // opens with real content instead of the skeleton. Laziness is structural,
  // not timed: this fires ONLY on post-paint user intent (hover/focus), so
  // FCP/LCP/TTFB can never observe it — there is no mount/idle prefetch.
  // Fire-and-forget with single-flight + TTL guards inside; no state set.
  const handlePrefetchIntent = useCallback(() => {
    prefetchWatchStatus();
  }, []);

  // Focus stewardship for keyboard users (WatchInbox mirror): into the
  // panel title on open, back to the button on close. Skipped on mount
  // (both refs start closed).
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      titleRef.current?.focus();
    } else if (!open && prevOpenRef.current && !historyOpenRef.current) {
      buttonRef.current?.focus();
    }
    prevOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent): void => {
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

  // Array.from (not slice) so a leading emoji surrogate pair stays whole.
  const initial = Array.from(nickname.trim())[0]?.toUpperCase() || '?';

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        onMouseEnter={handlePrefetchIntent}
        onFocus={handlePrefetchIntent}
        aria-expanded={open}
        aria-label={avatarAlt}
        className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border-2 border-purple-500/50 text-gray-200 hover:border-purple-400/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
      >
        <AvatarBadge avatarUrl={avatarUrl} initial={initial} size="button" />
      </button>

      {open && (
        <DropdownPanel
          ariaLabel={avatarAlt}
          maxHeightClass="max-h-[80vh]"
          header={
            <div className="mb-3 flex items-center gap-3 border-b border-gray-700 pb-3">
              <AvatarBadge
                avatarUrl={avatarUrl}
                initial={initial}
                size="header"
              />
              <p
                ref={titleRef}
                tabIndex={-1}
                className="truncate text-sm font-semibold text-gray-100 focus:outline-none"
              >
                {nickname}
              </p>
            </div>
          }
        >
          {/* Traveling bottom margin (not scroller padding): moves WITH the
              content, so scrolling never paints it over a fixed zone. */}
          <div className="mb-4">
            <WatchManager steamId={steamId} initialWatch={initialWatch} />
          </div>
          {/* History lives on the PANEL (not in WatchManager): it shows in
              every state — including session-expired/error, where the
              manager renders a bare gate — the moment the dropdown opens
              (no status poll to wait for), and the manager keeps its
              height-neutral skeleton untouched (no CLS from a new row).
              Rendered as a text link (not a pill button): it opens a
              modal in place, and a link affordance reads lighter next to
              the manager's action buttons. Kept a <button> element (not
              an <a>): there is no navigation target — it toggles UI. */}
          <div className="mb-1 flex items-center justify-center">
            <button
              type="button"
              onClick={handleOpenHistory}
              onMouseEnter={handleHistoryPrefetchIntent}
              onFocus={handleHistoryPrefetchIntent}
              // Mobile has no hover: warm the chunk on touch-start (the
              // synthetic mouseEnter fires too late, right before click).
              onTouchStart={handleHistoryPrefetchIntent}
              // Text-link look, button-sized target (WCAG 2.5.8 AA —
              // 24px floor; 44px matches the manager's pill height and
              // the panel's other rows): the underline reads lighter
              // than a pill while touch keeps a full-size hit area.
              className="inline-flex min-h-11 items-center rounded px-3 text-sm text-purple-300 underline decoration-purple-500/50 underline-offset-4 hover:text-purple-100 hover:decoration-purple-300"
            >
              {watchTranslator('watchHistoryButton')}
            </button>
          </div>
        </DropdownPanel>
      )}
      {historyOpen && <WatchHistoryModal onClose={handleCloseHistory} />}
    </div>
  );
}

export default SiteNavMenu;

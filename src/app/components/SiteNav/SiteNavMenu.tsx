'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';

import WatchManager from '@/app/components/WatchManager';
import {
  prefetchWatchStatus,
  type WarmWatchStatusSnapshot,
} from '@/app/templates/Home/hooks/watch/watchStatusPrefetch';

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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLParagraphElement | null>(null);
  const prevOpenRef = useRef(false);

  const handleToggle = () => {
    setOpen((wasOpen) => !wasOpen);
  };

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
    } else if (!open && prevOpenRef.current) {
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
        <div
          role="dialog"
          aria-label={avatarAlt}
          className="absolute right-0 z-50 mt-2 max-h-[80vh] w-80 max-w-[90vw] overflow-y-auto rounded-2xl border border-gray-600 bg-gray-900 p-4 shadow-xl"
        >
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
          <WatchManager steamId={steamId} initialWatch={initialWatch} />
        </div>
      )}
    </div>
  );
}

export default SiteNavMenu;

import React from 'react';

import DropdownArrow from '@/app/components/DropdownArrow/DropdownArrow';

interface DropdownPanelProps {
  /** Accessible name for the popover (panel title, avatar alt, ...). */
  ariaLabel: string;
  /** Static header row (title/badge or avatar/nickname): rendered ABOVE
      the scroll body with its own padding, so it never scrolls away and
      scrolling items never paint over it. */
  header: React.ReactNode;
  /** Max-height class for the whole panel — header and body share the
      budget. Default fits the inbox bell; the avatar menu passes a
      viewport-relative one. */
  maxHeightClass?: string;
  /** Extra classes for the scroll body (e.g. the inbox's branded
      scrollbar — panels with a native scrollbar pass nothing). */
  scrollClassName?: string;
  /** Scroll body content, composed by the caller. The scroller carries NO
      vertical padding (see the scroll-contract below); top/bottom
      breathing room lives in traveling content margins on this side. */
  children: React.ReactNode;
}

/**
 * Shared shell for the navbar dropdown panels (avatar menu, inbox bell):
 * positioned wrapper + caret + static header + scroll body. The trigger
 * buttons stay with the callers (bell vs avatar share nothing), and so do
 * the header/body contents (different headings, focus refs, and states).
 *
 * Scroll-contract (the reason for the split): a scroll container's padding
 * is a FIXED zone of the scrollport — scrolled items stay visible while
 * crossing it, which read as "content leaking over the padding". So the
 * scroller has horizontal padding only (px-4 is safe: nothing ever moves
 * sideways); vertical breathing room comes from content margins (mt-3/mb-4
 * on the body), which travel WITH the items. The outer owns the max height
 * as a flex column with overflow-hidden, which additionally clips scrolling
 * content to the rounded border. The caret lives on the positioned
 * wrapper — never inside the overflow body, which would clip its negative
 * top offset. The wrapper keeps role="dialog" so dismiss/focus contracts
 * and e2e role queries are unaffected.
 */
function DropdownPanel({
  ariaLabel,
  header,
  maxHeightClass = 'max-h-96',
  scrollClassName = '',
  children,
}: DropdownPanelProps) {
  return (
    <div
      role="dialog"
      aria-label={ariaLabel}
      className="absolute right-0 z-50 mt-2"
    >
      <DropdownArrow />
      <div
        className={`${maxHeightClass} flex w-80 max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-gray-600 bg-gray-900 shadow-xl`}
      >
        <div className="px-4 pt-4 pb-2">{header}</div>
        <div className={`min-h-0 overflow-y-auto px-4 ${scrollClassName}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default DropdownPanel;

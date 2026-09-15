import React from 'react';

/**
 * Textless loading placeholder for the avatar-dropdown watch panel.
 *
 * Same outer wrapper as every real WatchManager state (title + body +
 * footer, `gap-y-6`) plus a `min-h` approximating the common pending/none
 * heights, so the first-poll swap is height-neutral instead of growing the
 * absolutely-positioned dropdown after open (the CLS this file exists to
 * fix). Pure pulse blocks, no text — deliberately no next-intl dependency.
 * Screen readers skip it (`aria-hidden`); the real content announces
 * itself normally once the poll lands.
 *
 * Measured dialog heights (desktop, dropdown w-80 — identical wraps on
 * mobile since 320px < 90vw at 412px; mock-mode Edge, sep 2026):
 *   skeleton 451 | none en 443 / pt 467 / es 467 / de 491 / ru 523
 *   pending-live 259 / pending-expired 355 / active 259 (en)
 * min-h 360 keeps 3/5 locales within ±16px on the tallest state and
 * bounds the worst residual (ru none +72, short states shrink ≤192 on
 * cold opens only — hover→click bypasses the skeleton via prefetch).
 * Raising it to cover ru-none would push the common short-state shrink
 * past 260px, strictly worse on minimax.
 */
function WatchManagerSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-testid="watch-manager-skeleton"
      className="w-full max-w-xl mx-auto flex min-h-[360px] flex-col gap-y-6 text-center"
    >
      {/* Title row (watchTitle / watchPendingTitle / watchActiveTitle). */}
      <div className="h-8 w-3/4 mx-auto rounded-md bg-gray-700/60 animate-pulse" />
      {/* Body copy (description / hint / expired lines). */}
      <div className="flex flex-col gap-y-2">
        <div className="h-4 w-full rounded bg-gray-700/60 animate-pulse" />
        <div className="h-4 w-5/6 mx-auto rounded bg-gray-700/60 animate-pulse" />
      </div>
      {/* Footer actions (logout h-10 + primary h-12 on the tallest state). */}
      <div className="flex items-center justify-center gap-3">
        <div className="h-10 w-24 rounded-full bg-gray-700/60 animate-pulse" />
        <div className="h-12 w-32 rounded-full bg-gray-700/60 animate-pulse" />
      </div>
    </div>
  );
}

export default WatchManagerSkeleton;

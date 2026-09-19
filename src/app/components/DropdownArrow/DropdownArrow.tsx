import React from 'react';

interface DropdownArrowProps {
  /** Escape hatch for per-panel nudges; the default already centers the
      caret on a 44px (h-11 w-11) trigger button. */
  className?: string;
}

/**
 * Small caret visually anchoring a dropdown panel to its trigger button
 * (avatar menu, inbox bell). An 8px square rotated 45 degrees whose
 * top/left borders continue the panel's own border — the lower half hides
 * behind the panel body, so only the up-pointing tip shows.
 *
 * Placement contract: render as a child of the panel's POSITIONED wrapper
 * (the `absolute right-0` div), BEFORE the bordered scroll body — never
 * inside an `overflow-y-auto` element, which would clip the negative top
 * offset. `right-4` lands the 8px diamond center at 20px from the edge,
 * ~2px left of the 44px trigger center — visually negligible, and it keeps
 * the offset on the Tailwind scale (right-[18px] would be pixel-exact).
 * Purely decorative: aria-hidden, no pointer events, absolute (zero CLS
 * impact).
 */
function DropdownArrow({ className = '' }: DropdownArrowProps) {
  return (
    <span
      aria-hidden="true"
      data-testid="dropdown-arrow"
      className={`pointer-events-none absolute -top-1 right-4 block h-2 w-2 rotate-45 border-l border-t border-gray-600 bg-gray-900 ${className}`}
    />
  );
}

export default DropdownArrow;

import React from 'react';

interface HoverTooltipProps {
  text: string;
}

/**
 * Hover tooltip bubble shared by UserQuickLinks and the ShareBar trigger.
 * Pure CSS: the PARENT must carry the `group` class (and be `relative`) —
 * the bubble appears on hover AND on keyboard focus-within. `aria-hidden`
 * because the parent control already exposes the same text via aria-label.
 */
function HoverTooltip({ text }: HoverTooltipProps) {
  return (
    <span
      aria-hidden="true"
      className="
        absolute -top-9 left-1/2 -translate-x-1/2
        opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200
        pointer-events-none
        rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-white whitespace-nowrap
        before:absolute before:top-full before:left-1/2 before:-translate-x-1/2
        before:w-0 before:h-0
        before:border-l-[6px] before:border-r-[6px] before:border-t-[6px]
        before:border-l-transparent before:border-r-transparent
        before:border-t-slate-600
        after:absolute after:top-full after:left-1/2 after:-translate-x-1/2
        after:w-0 after:h-0
        after:border-l-4 after:border-r-4 after:border-t-4
        after:border-l-transparent after:border-r-transparent
        after:border-t-slate-800
      "
    >
      {text}
    </span>
  );
}

export default HoverTooltip;

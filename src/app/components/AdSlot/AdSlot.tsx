'use client';

/**
 * Manual AdSense units (see plan: Display homeTop/footer, In-article
 * playerInline). Adding a placement touches FIVE spots in this file by
 * design — AdSlotPlacement, resolveSlotId, PLACEMENT_CONFIG, the static
 * env-name literal list in AdSlot.test.tsx, and the call sites in
 * Home.tsx — plus `.env.example` and the Vercel env. Do NOT
 * "simplify" resolveSlotId into a dynamic `process.env[name]` lookup:
 * Next inlines NEXT_PUBLIC_* by static replacement only, so dynamic access
 * reads undefined in the browser (pinned by the source-pattern test in
 * AdSlot.test.tsx). Do NOT add `ssr: false` at the dynamic() call site
 * either: this component is SSR-safe (no window/headers in render; the
 * adsbygoogle push runs in useEffect) and server-rendering the reserved
 * wrapper is what keeps its mount CLS-free.
 */

import React, { useEffect } from 'react';
import { AD_PUBLISHER_ID } from '@/lib/ads';

export type AdSlotPlacement = 'homeTop' | 'playerInline' | 'footer';

/** Wire format of the <ins> unit (mirrors the AdSense account setup). */
type AdUnitFormat =
  | { kind: 'auto' }
  | { kind: 'in-article' };

interface PlacementConfig {
  /**
   * Reserved space while the ad fills (or fails to). The wrapper — never
   * the <ins> itself — carries the min-height, because AdSense rewrites the
   * ins's own sizing (height:auto !important on responsive fills). Tune per
   * placement once real fill sizes are known; in-article fluid varies more,
   * hence the taller mobile reserve.
   */
  minHeightClass: string;
  /** Wire format matching the unit type created in the AdSense account. */
  format: AdUnitFormat;
}

function readSlotId(raw: string | undefined): string | null {
  // Trim BOTH ways: a Vercel-pasted " 1234567890 " passes the blank check
  // but would land verbatim in data-ad-slot and break the auction.
  if (!raw || raw.trim() === '') {
    return null;
  }
  return raw.trim();
}

function resolveSlotId(placement: AdSlotPlacement): string | null {
  // One STATIC reference per placement — required for Next's compile-time
  // inlining (see the header comment). Do not refactor into a lookup.
  switch (placement) {
    case 'homeTop':
      return readSlotId(process.env.NEXT_PUBLIC_ADSLOT_HOME_TOP);
    case 'playerInline':
      return readSlotId(process.env.NEXT_PUBLIC_ADSLOT_PLAYER_INLINE);
    case 'footer':
      return readSlotId(process.env.NEXT_PUBLIC_ADSLOT_FOOTER);
    default:
      // Compile-time exhaustiveness (a new placement without a case fails
      // the build). Returns null rather than throwing: there is no error
      // boundary above, so a throw would take the whole page down — a
      // missing ad must never do that.
      return placement satisfies never;
  }
}

const PLACEMENT_CONFIG: Record<AdSlotPlacement, PlacementConfig> = {
  homeTop: {
    minHeightClass: 'min-h-[100px] md:min-h-[90px]',
    format: { kind: 'auto' },
  },
  playerInline: {
    minHeightClass: 'min-h-[280px] md:min-h-[250px]',
    format: { kind: 'in-article' },
  },
  footer: {
    minHeightClass: 'min-h-[100px] md:min-h-[90px]',
    format: { kind: 'auto' },
  },
};

interface WindowWithAds extends Window {
  adsbygoogle?: Record<string, unknown>[];
}

function pushAdSlot(): void {
  try {
    const w = window as unknown as WindowWithAds;
    w.adsbygoogle = w.adsbygoogle || [];
    w.adsbygoogle.push({});
  } catch {
    // Adblockers / privacy tools may neuter window.adsbygoogle — an ad
    // must never break the page.
  }
}

interface AdSlotProps {
  placement: AdSlotPlacement;
  /**
   * Server-computed AdSense gate (shouldLoadAds in the locale layout,
   * threaded through HomeProvider): true only on canonical production.
   * The slot renders NOTHING unless enabled AND its slot ID is set — so a
   * slot ID leaking onto a Preview/dev env never renders even an empty
   * reserved box there. Required (not defaulted): forgetting to wire it
   * must be a compile error, not a silent prod blackout.
   */
  enabled: boolean;
  /**
   * Extra classes for the wrapper (e.g. contextual spacing). Applied ONLY
   * when the slot renders — unconfigured slots still return null with zero
   * DOM, so surrounding rhythm is untouched without slot IDs.
   */
  className?: string;
}

function AdSlot({ placement, enabled, className }: AdSlotProps) {
  const config = PLACEMENT_CONFIG[placement];
  const slotId = resolveSlotId(placement);

  useEffect(() => {
    if (enabled && slotId) {
      pushAdSlot();
    }
  }, [enabled, slotId]);

  // Disabled gate (non-canonical host/env) or unconfigured slot (dev, e2e,
  // envs without slot IDs): render nothing — zero DOM, zero layout impact,
  // zero ad requests.
  if (!enabled || !slotId) {
    return null;
  }

  const isInArticle = config.format.kind === 'in-article';

  return (
    <div
      id={`ad-slot-${placement}`}
      data-testid={`ad-slot-${placement}`}
      className={`w-full overflow-hidden ${config.minHeightClass}${className ? ` ${className}` : ''}`}
    >
      <ins
        className="adsbygoogle"
        style={
          isInArticle
            ? { display: 'block', textAlign: 'center' }
            : { display: 'block' }
        }
        data-ad-client={AD_PUBLISHER_ID}
        data-ad-slot={slotId}
        data-ad-format={isInArticle ? 'fluid' : 'auto'}
        {...(isInArticle
          ? { 'data-ad-layout': 'in-article' }
          : { 'data-full-width-responsive': 'true' })}
      />
    </div>
  );
}

export default AdSlot;

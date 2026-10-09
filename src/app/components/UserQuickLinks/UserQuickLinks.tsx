'use client';

import React, { useMemo, useState } from 'react';
import Image from 'next/image';
import { track } from '@vercel/analytics';
import HoverTooltip from '@/app/components/HoverTooltip';
import useFaceitLink from './useFaceitLink';
import quickLinks from './data';

interface UserQuickLinksProps {
  steamId: string;
}

/** Icon with automatic fallback to an emoji or abbreviation if the image fails to load. */
function QuickLinkIcon({
  iconUrl,
  icon,
  title,
}: {
  iconUrl?: string;
  icon: string;
  title: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  if (iconUrl && !imgFailed) {
    return (
      <Image
        src={iconUrl}
        alt={`${title} icon`}
        fill
        sizes="50px"
        onError={() => setImgFailed(true)}
        className="rounded-full object-cover"
      />
    );
  }
  return (
    <span className="rounded-full w-full h-full flex items-center justify-center text-sm bg-gray-800 text-white">
      {icon}
    </span>
  );
}

export default function UserQuickLinks({ steamId }: UserQuickLinksProps) {
  const { url: faceitUrl, isLoading: isLoadingFaceit } = useFaceitLink(steamId);

  // Resolves the final URL for each link only once per relevant render,
  // instead of recalculating everything (including encoding) on every click.
  const resolvedLinks = useMemo(
    () =>
      quickLinks.map((link) => ({
        ...link,
        resolvedUrl: link.id === 'faceit' ? faceitUrl : link.getUrl(steamId),
      })),
    [steamId, faceitUrl],
  );

  const numCols = Math.min(4, resolvedLinks.length);

  return (
    <div className="w-full pt-2">
      <div
        className="grid gap-2 mx-auto"
        style={{
          gridTemplateColumns: `repeat(${numCols}, minmax(30px, 50px))`,
        }}
      >
        {resolvedLinks.map((link) => {
          const isDisabled = link.isDynamic && isLoadingFaceit;

          return (
            <a
              key={link.id}
              href={link.resolvedUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={link.title}
              aria-disabled={isDisabled}
              onClick={(e) => {
                if (isDisabled) {
                  e.preventDefault();
                  return;
                }
                track('quick_link_click', { site: link.id });
              }}
              // `group` enables the HoverTooltip below to appear on hover/focus.
              // `aspect-square` locks height to the grid column's width —
              // required for the `fill` Image below to have a non-zero
              // parent to fill (fill uses position:absolute internally,
              // which collapses to 0 height without this).
              className={`group relative flex items-center justify-center aspect-square ${
                isDisabled ? 'opacity-50 pointer-events-none' : ''
              }`}
              tabIndex={isDisabled ? -1 : undefined}
            >
              {isDisabled ? (
                <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <QuickLinkIcon
                  iconUrl={link.iconUrl}
                  icon={link.icon}
                  title={link.title}
                />
              )}

              <HoverTooltip text={link.title} />
            </a>
          );
        })}
      </div>
    </div>
  );
}

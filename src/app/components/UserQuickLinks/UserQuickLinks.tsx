'use client';

import React, { useMemo, useState } from 'react';
import { track } from '@vercel/analytics';
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
      <img
        src={iconUrl}
        alt={`${title} icon`}
        loading="lazy"
        onError={() => setImgFailed(true)}
        className="rounded-full w-full h-full object-cover"
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
              // `group` enables the tooltip below to appear on hover.
              className={`group relative flex items-center justify-center ${
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

              <div
                className="
                  absolute -top-9 left-1/2 -translate-x-1/2
                  opacity-0 group-hover:opacity-100 transition-opacity duration-200
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
                {link.title}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

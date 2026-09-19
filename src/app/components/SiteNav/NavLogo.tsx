'use client';

import Image from 'next/image';
import Link from 'next/link';
import React, { useState } from 'react';

/**
 * Mobile navbar logo (the only nav asset that needs a round-trip): gets
 * the same skeleton contract as the Suspense fallback — a pulsing
 * placeholder (bg-gray-700/60, same visual language) covers the full
 * 40px link box (p-1 + 32px image) until next/image finishes loading,
 * so the fallback→real swap never shows an empty gap. On failure it
 * degrades to the wordmark (font-inkut, brand string — locale-proof),
 * mirroring AvatarBadge's letter-initial contract: global chrome never
 * shows a broken image. Server Component hosts import this as a client
 * island, same as LanguageSwitcher/WatchInbox.
 */
function NavLogo() {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  return (
    <Link href="/" aria-label="SteamReveal" className="group sm:hidden p-1">
      {failed ? (
        <span className="font-inkut text-lg leading-8 text-white">
          SteamReveal
        </span>
      ) : (
        <span className="relative block h-8 w-8">
          {!loaded && (
            <span
              aria-hidden="true"
              className="absolute -inset-1 animate-pulse rounded bg-gray-700/60"
            />
          )}
          <Image
            src="/images/logo.png"
            width={32}
            height={32}
            // Decorative: the accessible name comes from the Link's
            // aria-label (AvatarBadge precedent) — an alt here would
            // double-announce next to it.
            alt=""
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className="cursor-pointer transition-[filter] duration-200 group-hover:drop-shadow-[0_0_6px_rgba(255,255,255,0.25)]"
          />
        </span>
      )}
    </Link>
  );
}

export default NavLogo;

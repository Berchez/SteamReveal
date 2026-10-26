'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';
import { recordLoginCta } from '@/app/templates/Home/shared/analytics/loginFunnel';

/**
 * Single sign-in upsell shown between the second and third friend card for
 * logged-out visitors. The first two friends keep their GC Name so the
 * feature is visible before the gate; the remaining cards render a lock
 * chip instead of a per-card login button. One banner = one CTA.
 */
function GamersClubBanner({ lockedCount }: { lockedCount: number }) {
  const tIndex = useTranslations('Index');
  const tWatch = useTranslations('Watch');
  const locale = useLocale();
  const pathname = usePathname();
  const next = resolveLoginNext(pathname, locale);

  return (
    <div
      data-testid="gc-name-upsell-banner"
      data-locked-count={lockedCount}
      className="mt-8 rounded-xl border border-purple-600/40 bg-purple-900/30 p-5 text-left text-white"
    >
      <p className="text-lg font-semibold text-gray-100">
        {tIndex('gcUpsellTitle')}
      </p>
      <p className="mt-2 text-sm text-gray-300">
        {tIndex('gcUpsellDescription', { count: lockedCount })}
      </p>
      <a
        href={`/api/auth/steam/login?next=${encodeURIComponent(next)}`}
        onClick={() => {
          recordLoginCta();
        }}
        className="mt-4 inline-block rounded-full bg-purple-700 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-600/90"
      >
        {tWatch('watchLoginButton')}
      </a>
    </div>
  );
}

export default GamersClubBanner;

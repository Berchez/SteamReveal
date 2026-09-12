'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';

/**
 * Logged-out navbar sign-in: preserves the page the user is ON as the
 * post-login `next` (the navbar is global — a sign-in from /player/x must
 * return to /player/x, not the home page). The login route re-validates
 * `next` as an internal path server-side, so this is convenience, not a
 * trust boundary.
 */
function SiteNavSignIn() {
  const t = useTranslations('Watch');
  const locale = useLocale();
  const pathname = usePathname();
  const next = resolveLoginNext(pathname, locale);

  return (
    <a
      href={`/api/auth/steam/login?next=${encodeURIComponent(next)}`}
      className="inline-block h-11 px-4 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[2.75rem]"
    >
      {t('watchNavSignIn')}
    </a>
  );
}

export default SiteNavSignIn;

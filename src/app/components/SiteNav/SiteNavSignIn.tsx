'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';

/**
 * Logged-out navbar sign-in entry (login-first model): a single Steam
 * sign-in pill — there is deliberately NO separate "add the bot" step
 * here. Users who are not yet friends land in the waiting room
 * (`?login=waiting`) after OpenID, which teaches the add-the-bot step
 * and completes the login by itself once the friendship appears.
 *
 * The sign-in preserves the page the user is ON as the post-login
 * `next` (the navbar is global — a sign-in from /player/x must return
 * to /player/x, not the home page). The login route re-validates `next`
 * as an internal path server-side, so this is convenience, not a trust
 * boundary.
 *
 * `botOnline` is the bot-liveness gate (server-computed, fail-open): when
 * the bot is offline the whole cluster renders NOTHING, so a user never
 * burns a Steam login round-trip only to hit the waiting room that can't
 * complete. Absence is deliberate — no disabled pill, no copy, no raised
 * expectation. The cluster is fixed-position, so disappearing causes zero
 * CLS.
 */
function SiteNavSignIn({ botOnline }: { botOnline: boolean }) {
  const t = useTranslations('Watch');
  const locale = useLocale();
  const pathname = usePathname();
  const next = resolveLoginNext(pathname, locale);

  if (!botOnline) return null;

  return (
    <div className="flex items-center gap-2">
      <a
        href={`/api/auth/steam/login?next=${encodeURIComponent(next)}`}
        className="inline-block h-11 px-4 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[2.75rem]"
      >
        {t('watchNavSignIn')}
      </a>
    </div>
  );
}

export default SiteNavSignIn;

'use client';

import React, { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';

import { useWatchStatus } from '@/app/templates/Home/hooks/watch/useWatchStatus';

/**
 * Watch panel content (Steam OpenID + bot-link confirmation era): the
 * SteamID arrives as a prop from the server-rendered surface (verified
 * login session). Rendered inside the navbar avatar dropdown.
 *
 * Creation is EXPLICIT and goes through signup, never watch/request
 * directly: the Start button POSTs /api/auth/signup (account + watch +
 * invite, all idempotent), and the same click never re-fires while in
 * flight. Mounts and revisits NEVER create anything by themselves — that
 * is what keeps an opt-out (unfriend → row deleted → status 'none') from
 * silently re-subscribing the user on the next visit.
 */
function WatchManager({ steamId }: { steamId: string }) {
  const translator = useTranslations('Watch');
  // Requester locale travels with the signup so the bot's confirm link
  // message (and later the welcome message) is composed in the user's
  // language, not the default.
  const locale = useLocale();
  // Re-login preserves the page the user is on (same rationale as
  // SiteNavSignIn): a session dying mid-use on /player/x must return
  // there, not the home page.
  const pathname = usePathname();
  const loginNext = resolveLoginNext(pathname, locale);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const { status, error: statusError } = useWatchStatus({
    steamId,
    enabled: true,
  });

  const handleStart = useCallback(async () => {
    if (requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) {
        setRequestError(translator('watchErrorFailed'));
      }
      // Success needs no local state: the status poll picks up
      // pending/active on its next tick by itself.
    } catch {
      setRequestError(translator('watchErrorFailed'));
    } finally {
      setRequesting(false);
    }
  }, [requesting, locale, translator]);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Logout is best-effort client-side: the reload below lands on the
      // login gate either way when the cookie is gone, and shows this
      // screen again (with a fresh session read) when it is not.
    } finally {
      window.location.reload();
    }
  }, [loggingOut]);

  if (statusError === 'session-expired') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <p role="alert" className="text-red-400 text-sm">
          {translator('watchLoginError')}
        </p>
        <div>
          <a
            href={`/api/auth/steam/login?next=${encodeURIComponent(loginNext)}`}
            className="inline-block h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[3rem]"
          >
            {translator('watchLoginButton')}
          </a>
        </div>
      </div>
    );
  }

  if (statusError !== null) {
    // Defensive branch: the id arrives server-verified, so 'invalid' (or
    // any future hook error) means a bug, not user input — say so plainly
    // instead of rendering a blank screen.
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <p role="alert" className="text-red-400 text-sm">
          {translator('watchErrorFailed')}
        </p>
      </div>
    );
  }

  // Shared footer for the actionable screens (alert parity + one logout
  // button definition — the states must never drift apart).
  const renderFooter = (showLogout: boolean) => (
    <>
      {requestError !== null && (
        <p role="alert" className="text-red-400 text-sm">
          {requestError}
        </p>
      )}
      {showLogout && (
        <div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="h-10 px-5 rounded-full border border-gray-500 text-gray-300 text-sm hover:border-gray-300 disabled:opacity-50"
          >
            {translator('watchLogout')}
          </button>
        </div>
      )}
    </>
  );

  if (status === 'active') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchActiveTitle')}
        </h1>
        <p className="text-gray-300">{translator('watchActiveHint')}</p>
        {renderFooter(true)}
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchPendingTitle')}
        </h1>
        <p className="text-gray-300">{translator('watchPendingHint')}</p>
        {renderFooter(true)}
      </div>
    );
  }

  if (status === 'none') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchTitle')}
        </h1>
        <p className="text-gray-300">{translator('watchDescription')}</p>
        <p className="text-gray-400 text-sm">
          {translator('watchSignupSteps')}
        </p>
        {renderFooter(false)}
        <div>
          <button
            type="button"
            onClick={handleStart}
            disabled={requesting}
            className="h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 disabled:opacity-50 text-white font-semibold text-sm"
          >
            {translator('watchSubmit')}
          </button>
        </div>
      </div>
    );
  }

  // Status unknown (first poll in flight): render nothing rather than a
  // wrong state — the poll resolves within one interval.
  return null;
}

export default WatchManager;

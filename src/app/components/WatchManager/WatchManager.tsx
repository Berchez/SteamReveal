'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';

import { useWatchStatus } from '@/app/templates/Home/hooks/watch/useWatchStatus';
import {
  clearWatchStatusPrefetch,
  type WarmWatchStatusSnapshot,
} from '@/app/templates/Home/hooks/watch/watchStatusPrefetch';

import WatchManagerSkeleton from './WatchManagerSkeleton';

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
function WatchManager({
  steamId,
  initialWatch = null,
}: {
  steamId: string;
  /** Server-seeded first paint from SiteNav (null = cold open, skeleton). */
  initialWatch?: WarmWatchStatusSnapshot | null;
}) {
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
  const [resending, setResending] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  const { status, error: statusError, confirmExpired, confirmLinkSent } = useWatchStatus({
    steamId,
    enabled: true,
    initialWatch,
  });
  const linkSentHint = confirmLinkSent ? translator('watchLinkSentHint') : translator('watchPendingHint');

  // Resend-button lifecycle: the button shows while the link is expired
  // and no fresh one was requested yet. Reset whenever `confirmExpired`
  // changes, in either direction: a fresh delivery arrived (expired→live —
  // show "check your chat", not "on its way" forever) or a new expiry
  // cycle started (live→expired — the button shows again). No ref needed
  // to detect the edge: this effect only runs on mount (resendSent starts
  // false, so the reset is a no-op) and on expired flips (where a reset
  // is always correct). A confirmLinkSent level check can NOT mark the
  // delivery instead: the dead token already reports linkSent=true while
  // the user waits. A remount (dropdown close/reopen) also resets, since
  // the state is per-mount.
  // Known residual (accepted, transient): a DB blip that degrades one
  // status poll to expired=false flips this early (wrong hint for one
  // poll, ~5s) until the next good poll restores the button. Harmless —
  // the server throttle bounds duplicate resends either way, and tracking
  // generations (confirmExpiresAt in the status payload) would cost a
  // shared-shape change across route/hook/prefetch/seed for a cosmetic
  // transient.
  useEffect(() => {
    setResendSent(false);
  }, [confirmExpired]);

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
      // Drop any hover-prefetched status: the next login is a different
      // session that must never read this one's hint. The reload wipes
      // module state anyway — belt-and-braces for a future client-side
      // logout without reload.
      clearWatchStatusPrefetch();
      window.location.reload();
    }
  }, [loggingOut]);

  const handleResend = useCallback(async () => {
    if (resending || resendSent) return;
    setResending(true);
    try {
      const res = await fetch('/api/auth/confirm-resend', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as {
        ok?: unknown;
      } | null;
      if (!res.ok || body?.ok !== true) {
        setRequestError(translator('watchErrorFailed'));
      } else {
        // Queued (or already handled server-side): the bot delivers the
        // fresh link over Steam chat — poll for it there, not here.
        setResendSent(true);
      }
    } catch {
      setRequestError(translator('watchErrorFailed'));
    } finally {
      setResending(false);
    }
  }, [resending, resendSent, translator]);

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

  // Shared footer for the actionable screens: one logout button definition
  // plus the request-error alert — the states must never drift apart.
  // Logout shows on ALL three states, including 'none': a logged-in user
  // with no watch row must still be able to sign out (otherwise the only
  // exit is clearing site cookies by hand). The 'none' screen passes its
  // Start button as `extra`, rendered on the same row (logout left,
  // primary action right).
  const renderFooter = (extra?: React.ReactNode) => (
    <>
      {requestError !== null && (
        <p role="alert" className="text-red-400 text-sm">
          {requestError}
        </p>
      )}
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="h-10 px-5 rounded-full border border-gray-500 text-gray-300 text-sm hover:border-gray-300 disabled:opacity-50"
        >
          {translator('watchLogout')}
        </button>
        {extra}
      </div>
    </>
  );

  if (status === 'active') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchActiveTitle')}
        </h1>
        <p className="text-gray-300">{translator('watchActiveHint')}</p>
        {renderFooter()}
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchPendingTitle')}
        </h1>
        {!confirmExpired && (
          <p className="text-gray-300">
            {resendSent ? translator('watchResendSent') : linkSentHint}
          </p>
        )}
        {confirmExpired && !resendSent && (
          <>
            <p className="text-gray-300">{translator('watchLinkExpired')}</p>
            <div>
              <button
                type="button"
                onClick={handleResend}
                disabled={resending}
                className="h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 disabled:opacity-50 text-white font-semibold text-sm"
              >
                {translator('watchResendSubmit')}
              </button>
            </div>
          </>
        )}
        {confirmExpired && resendSent && (
          <p className="text-gray-300">{translator('watchResendSent')}</p>
        )}
        {renderFooter()}
      </div>
    );
  }

  // 'none' may come from a stale warm cache (hover prefetch ≤15s old) while
  // the live row is already pending/active. Offering Start anyway is safe:
  // POST /api/auth/signup is idempotent — over an existing row it answers
  // ok with inviteQueued:false and queues nothing (pinned by the signup
  // route's stale-warm-none test). Disabling the button until revalidation
  // would trade a harmless no-op for a visibly dead CTA on every open.
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
        {renderFooter(
          <button
            type="button"
            onClick={handleStart}
            disabled={requesting}
            className="h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 disabled:opacity-50 text-white font-semibold text-sm"
          >
            {translator('watchSubmit')}
          </button>,
        )}
      </div>
    );
  }

  // Status unknown (first poll in flight): render a height-neutral skeleton
  // rather than a wrong state — or nothing, which grows the avatar dropdown
  // after open and shifts layout (CLS). Same wrapper + min-h as the real
  // states, so the poll swap is a content change, not a size change.
  return <WatchManagerSkeleton />;
}

export default WatchManager;

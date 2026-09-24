'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';
import { pendingPollDelay } from '@/lib/watch/pendingPolicy';
import { recordLoginCta } from '@/app/templates/Home/shared/analytics/loginFunnel';

/**
 * Waiting room for the login-first flow (`?login=waiting`): the OpenID
 * identity is already proven server-side, only the bot friendship is
 * outstanding. Polls `GET /api/auth/steam/pending` until it completes the
 * login by itself — the user just adds the bot in another tab and comes
 * back to a finished login (no second Steam dance).
 *
 * Mounted unconditionally next to QueryToast (Home covers `/` AND
 * `/player/*`); renders null without the param. Zero props by design: the
 * bot-profile URL rides the first poll response (server env stays
 * server-side), and the retry link rebuilds `next` from the current page
 * like every other sign-in surface.
 *
 * Poll discipline (cadence owned by pendingPolicy — 10s fast tier, then
 * 30s): immediate first hit (the friendship may have landed between the
 * callback and this mount). Hidden tabs skip the fetch (same hidden-tab
 * precedent as the avatar hover-prefetch: no point burning shared Steam
 * quota for a screen nobody sees) and poll immediately on return to
 * foreground. A visibility ping never doubles a fetch already in flight
 * (single-flight guard). Network blips never kill the wait (retry next
 * tick); only an explicit `expired` flips to the start-over screen, which
 * strips the param one-shot like the toasts do. StrictMode's remount only
 * restarts the loop (idempotent GET, convergent completion).
 */

type RoomPhase = 'waiting' | 'expired';

type PendingBody = {
  done?: unknown;
  expired?: unknown;
  redirect?: unknown;
  botProfileUrl?: unknown;
};

const stripLoginParam = (): void => {
  const url = new URL(window.location.href);
  url.searchParams.delete('login');
  window.history.replaceState(null, '', url.toString());
};

function PendingLoginRoom() {
  const t = useTranslations('Watch');
  const locale = useLocale();
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<RoomPhase>('waiting');
  const [botProfileUrl, setBotProfileUrl] = useState<string | null>(null);
  const loginNext = resolveLoginNext(pathname, locale);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      new URLSearchParams(window.location.search).get('login') !== 'waiting'
    ) {
      return undefined;
    }
    setActive(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let scheduledWaits = 0;
    const poll = async (): Promise<void> => {
      // Next wait on the shared tier schedule (see pendingPolicy). Nested
      // (not sibling) on purpose: a sibling helper referencing `poll`
      // trips no-use-before-define, while everything inside `poll`'s own
      // body sits textually after its declaration.
      const scheduleNext = (): void => {
        if (cancelled) return;
        const delay = pendingPollDelay(scheduledWaits);
        scheduledWaits += 1;
        timer = setTimeout(poll, delay);
      };
      // Single-flight: a visibility ping landing while a fetch is still
      // outstanding skips instead of doubling it (the owner converges).
      if (inFlight) return;
      // Hidden tab: no fetch (shared Steam quota is not spent on an
      // unseen screen), just stay on schedule — the visibility listener
      // below fires an immediate poll on return.
      if (document.visibilityState === 'hidden') {
        scheduleNext();
        return;
      }
      inFlight = true;
      try {
        const res = await fetch('/api/auth/steam/pending', { method: 'GET' });
        const body = (await res.json().catch(() => null)) as PendingBody | null;
        if (cancelled || body === null) {
          scheduleNext();
          return;
        }
        if (typeof body.botProfileUrl === 'string' && body.botProfileUrl !== '') {
          setBotProfileUrl(body.botProfileUrl);
        }
        if (body.done === true && typeof body.redirect === 'string') {
          // Full navigation (not router.push): the session cookie is brand
          // new and SSR must re-resolve chrome (avatar, inbox) server-side.
          window.location.href = body.redirect;
          return;
        }
        if (body.expired === true) {
          setPhase('expired');
          stripLoginParam();
          return;
        }
      } catch {
        // Network blip mid-wait: stay on the waiting screen, retry next
        // tick. Only an explicit `expired` ends the wait.
      } finally {
        inFlight = false;
      }
      scheduleNext();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // Mount-only on purpose (same rationale as QueryToast): re-running on
    // translator/pathname identity change would restart a healthy wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move assistive focus into the blocking overlay on appearance (and on
  // the wait→expired switch): without it a keyboard/screen-reader user is
  // left tabbing behind the backdrop. A full focus trap is follow-up work;
  // the page behind stays reachable, which is acceptable for a transient
  // login screen but should be revisited with the lane cleanup.
  useEffect(() => {
    if (active) headingRef.current?.focus();
  }, [active, phase]);

  if (!active) {
    // No-JS fallback: the room is client-driven and this gate only ever
    // opens client-side, so without scripts the wait would be a silent
    // dead page. This static block IS the SSR HTML (browser-hidden
    // whenever JS runs) and says the one honest thing instead. Bare
    // string child on purpose: element children do not survive inside
    // <noscript> (neither in browsers with scripting on nor in SSR
    // round-trips) — unstyled text beats a swallowed tree.
    return <noscript>{t('watchWaitNoScript')}</noscript>;
  }

  return (
    <div data-testid="pending-login-room" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role={phase === 'expired' ? 'alert' : 'status'}
        className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-8 text-center shadow-2xl"
      >
        {phase === 'waiting' ? (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-gray-100">
              {t('watchWaitTitle')}
            </h1>
            <p className="mt-3 text-gray-300">{t('watchWaitBody')}</p>
            {botProfileUrl !== null && (
              <div className="mt-6">
                <a
                  href={botProfileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[3rem]"
                >
                  {t('watchWaitAddBot')}
                </a>
              </div>
            )}
            <p className="mt-4 text-sm text-gray-400">
              {t('watchWaitWaiting')}
            </p>
          </>
        ) : (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-gray-100">
              {t('watchWaitTitle')}
            </h1>
            <p className="mt-3 text-gray-300">{t('watchWaitExpired')}</p>
            <div className="mt-6">
              <a
                href={`/api/auth/steam/login?next=${encodeURIComponent(loginNext)}`}
                onClick={() => {
                  // Retry after an expired wait starts a FRESH OpenID dance
                  // that can produce its own completion — beacon it too, or
                  // the conversion rate counts completions without clicks.
                  recordLoginCta();
                }}
                className="inline-block h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[3rem]"
              >
                {t('watchWaitRetry')}
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default PendingLoginRoom;

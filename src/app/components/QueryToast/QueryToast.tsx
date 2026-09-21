'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ToastContainer, toast } from 'react-toastify';

type ToastKind =
  | 'confirm-ok'
  | 'confirm-error'
  | 'watch-new'
  | 'auth-error'
  | null;

// Scoped container: the fire-on-load toast must not depend on the global
// ToastContainer's mount timing (a global-container race drops the toast
// silently when this effect wins). The container below is this
// component's own child, so its subscription effect always runs before
// this component's firing effect (React flushes child effects first) —
// delivery is deterministic by construction, and containerId keeps the
// toast out of the global container (no duplicates).
const QUERY_TOAST_CONTAINER_ID = 'query-toast';

/**
 * One-shot query-param toast for landings that redirect back to /: the
 * bot-link confirm endpoint (`?confirmed=ok|error`), the single-state
 * first-login landing (`?watch=new` — "your watch is live", the only
 * such signal now that no pending state ever exists), and the failed
 * Steam callback leg (`?auth=error` generic — non-friends land in the
 * waiting room instead of an error, so there is no denial toast). Fires once through
 * react-toastify (the single toast mechanism in this app), then strips
 * the param so a refresh/back-navigation never replays it. Unknown
 * values fire nothing (never a wrong message).
 */
function QueryToast() {
  const t = useTranslations('Watch');

  useEffect(() => {
    // Deferred a macrotask past mount on purpose: the scoped container
    // subscribes during the commit, and firing synchronously inside this
    // same effect has proven unreliable in dev (StrictMode remount +
    // container-subscription timing eats the toast). A macrotask fires
    // after every mount subscription settled, so delivery is direct, not
    // queue-dependent. Cleanup clears the pending fire so StrictMode's
    // simulated unmount never double-fires (exactly-once in prod's single
    // mount AND in dev's remount).
    const timer = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      let kind: ToastKind = null;
      // confirmed wins when several land together (each producer emits at
      // most one param; the overlap is only hand-crafted URLs). watch-new
      // (single-state first login) beats auth for the same reason.
      if (params.get('confirmed') === 'ok') kind = 'confirm-ok';
      else if (params.get('confirmed') === 'error') kind = 'confirm-error';
      else if (params.get('watch') === 'new') kind = 'watch-new';
      else if (params.get('auth') === 'error') kind = 'auth-error';
    if (kind === null) return;
    // Explicit roles: react-toastify defaults EVERYTHING to role="alert"
    // (assertive), which would make the success toast interrupt screen
    // readers like an error. Success stays polite ("status"), errors stay
    // assertive ("alert") — the same contract the previous custom pill had.
    const base = { containerId: QUERY_TOAST_CONTAINER_ID } as const;
    if (kind === 'confirm-ok')
      toast.success(t('watchConfirmOk'), { ...base, role: 'status' });
    else if (kind === 'confirm-error')
      toast.error(t('watchConfirmError'), { ...base, role: 'alert' });
    else if (kind === 'watch-new')
      toast.success(t('watchWelcome'), { ...base, role: 'status' });
    else toast.error(t('watchLoginError'), { ...base, role: 'alert' });
      const url = new URL(window.location.href);
      url.searchParams.delete('confirmed');
      url.searchParams.delete('watch');
      url.searchParams.delete('auth');
      window.history.replaceState(null, '', url.toString());
    }, 0);
    return () => clearTimeout(timer);
    // Mount-only on purpose (see above): re-firing on translator identity
    // change would duplicate the toast in production.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ToastContainer containerId={QUERY_TOAST_CONTAINER_ID} theme="dark" />;
}

export default QueryToast;

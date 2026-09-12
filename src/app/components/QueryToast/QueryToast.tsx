'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

type ToastKind = 'confirm-ok' | 'confirm-error' | 'auth-error' | null;

/**
 * One-shot query-param toast for landings that redirect back to /: the
 * bot-link confirm endpoint (`?confirmed=ok|error`) and the failed Steam
 * callback leg (`?auth=error`). Renders the matching localized message,
 * then strips the param so a refresh/back-navigation never replays it.
 * Unknown values render nothing (never a wrong message).
 */
function QueryToast() {
  const t = useTranslations('Watch');
  const [kind, setKind] = useState<ToastKind>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let next: ToastKind = null;
    // confirmed wins when both land together (the confirm endpoint never
    // emits auth, so the overlap is only hand-crafted URLs).
    if (params.get('confirmed') === 'ok') next = 'confirm-ok';
    else if (params.get('confirmed') === 'error') next = 'confirm-error';
    else if (params.get('auth') === 'error') next = 'auth-error';
    if (next === null) return;
    setKind(next);
    const url = new URL(window.location.href);
    url.searchParams.delete('confirmed');
    url.searchParams.delete('auth');
    window.history.replaceState(null, '', url.toString());
  }, []);

  if (kind === null) return null;

  let message = t('watchLoginError');
  if (kind === 'confirm-ok') message = t('watchConfirmOk');
  if (kind === 'confirm-error') message = t('watchConfirmError');

  return (
    <div
      role={kind === 'confirm-ok' ? 'status' : 'alert'}
      className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-3 text-sm font-medium shadow-lg ${
        kind === 'confirm-ok' ? 'bg-green-700 text-white' : 'bg-red-700 text-white'
      }`}
    >
      {message}
    </div>
  );
}

export default QueryToast;

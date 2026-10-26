'use client';

import { useSyncExternalStore } from 'react';

import { WATCH_SESSION_HINT_COOKIE } from '@/lib/watch/sessionCookie';

export const hasSessionHintCookie = (): boolean => {
  if (typeof document === 'undefined') {
    return false;
  }

  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .some((part) => part.startsWith(`${WATCH_SESSION_HINT_COOKIE}=`));
};

const subscribe = () => () => undefined;

export const useSessionHint = (): boolean =>
  useSyncExternalStore(
    subscribe,
    hasSessionHintCookie,
    () => false,
  );

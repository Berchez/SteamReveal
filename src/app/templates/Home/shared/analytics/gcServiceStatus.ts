'use client';

import { useSyncExternalStore } from 'react';

/**
 * Availability of the GamersClub scraper (the local proxy that talks to
 * gamersclub.com.br), as observed by the browser.
 *
 * The GC Name feature depends on a LOCAL process being up: when it is
 * down, every lookup answers "unavailable" and NO player shows a GC Name.
 * The logged-out upsell banner ("sign in to unlock the remaining GC
 * Names") must therefore not be shown while the scraper is offline — it
 * would sell a feature that cannot work right now.
 *
 * Kept module-scoped (like friendGcNameStore) because it describes a
 * service, not a component: every card that resolves a GC Name reports
 * the same status, and the section that owns the banner only needs to
 * read it. 'unknown' is the initial state — no lookup has completed yet,
 * so the banner is shown as usual until a lookup proves otherwise.
 */
export type GcServiceStatus = 'unknown' | 'available' | 'unavailable';

let status: GcServiceStatus = 'unknown';
const listeners = new Set<() => void>();

export const setGcServiceStatus = (next: GcServiceStatus): void => {
  if (status === next) return;
  status = next;
  listeners.forEach((listener) => listener());
};

export const getGcServiceStatus = (): GcServiceStatus => status;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useGcServiceStatus = (): GcServiceStatus =>
  useSyncExternalStore(subscribe, getGcServiceStatus, getGcServiceStatus);

/** Test-only: reset the status between tests. */
export const resetGcServiceStatus = (): void => {
  status = 'unknown';
  listeners.forEach((listener) => listener());
};

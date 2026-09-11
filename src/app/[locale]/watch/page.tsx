import { cookies } from 'next/headers';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import React from 'react';

import WatchInbox from '@/app/components/WatchInbox';
import WatchLogin from '@/app/components/WatchLogin';
import WatchManager from '@/app/components/WatchManager';
import { resolveWatchSession } from '@/lib/watch/session';

interface WatchPageProps {
  params: {
    locale: string;
  };
  searchParams?: {
    auth?: string;
  };
}

export async function generateMetadata({
  params: { locale },
}: WatchPageProps): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Metadata.Watch' });

  return {
    title: t('title'),
    description: t('description'),
    alternates: {
      canonical: `https://steam-reveal.vercel.app/${locale}/watch`,
    },
  };
}

/**
 * Watch hub: the session (read server-side, never from client input)
 * decides everything. Logged out → Steam login gate (with the callback
 * error state when `?auth=error`); logged in → manager + inbox for
 * exactly that SteamID. No localStorage identity anywhere in this tree.
 */
export default async function WatchPage({
  searchParams,
}: Pick<WatchPageProps, 'searchParams'>) {
  // Same resolveWatchSession contract as the API routes — and, unlike
  // them, WITHOUT a catch: resolveWatchSession never rejects by contract,
  // so a throw here can only mean a programming error, which should crash
  // loudly (Next error boundary + server log) rather than masquerade as a
  // logged-out visitor. A broken SESSION_SECRET surfaces the same way.
  const session = await resolveWatchSession(cookies());
  const steamId = session.status === 'authenticated' ? session.steamId : null;
  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-y-6 px-4 py-8">
      {steamId === null ? (
        <WatchLogin authError={searchParams?.auth === 'error'} />
      ) : (
        <>
          <WatchManager steamId={steamId} />
          <WatchInbox steamId={steamId} />
        </>
      )}
    </main>
  );
}

import React from 'react';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import WatchManager from '@/app/components/WatchManager';
import WatchInbox from '@/app/components/WatchInbox';

interface WatchPageProps {
  params: {
    locale: string;
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

export default function WatchPage() {
  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-y-6 px-4 py-8">
      <WatchManager />
      {/* Bell lives on the watch hub only (not Home): it needs the stored
        identity, which only exists after a watch request. Self-contained:
        renders nothing without one, fetches nothing without one. */}
      <WatchInbox />
    </main>
  );
}

import React from 'react';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import WatchManager from '@/app/components/WatchManager';

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
    <main className="min-h-dvh flex items-center justify-center px-4 py-8">
      <WatchManager />
    </main>
  );
}

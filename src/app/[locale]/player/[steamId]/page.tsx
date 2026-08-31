import React from 'react';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Home from '@/app/templates/Home';
import getPlayerProfile from '@/lib/getPlayerProfile';

interface PlayerPageProps {
  params: {
    locale: string;
    steamId: string;
  };
}

export async function generateMetadata({
  params: { locale, steamId },
}: PlayerPageProps): Promise<Metadata> {
  const profile = await getPlayerProfile(steamId);
  const t = await getTranslations({ locale, namespace: 'Metadata.Player' });

  if (!profile) {
    return {
      title: t('fallbackTitle'),
      description: t('fallbackDescription'),
    };
  }

  const title = t('title', { nickname: profile.nickname });
  const description = t('description', { nickname: profile.nickname });

  return {
    title,
    description,
    alternates: {
      canonical: `https://steam-reveal.vercel.app/${locale}/player/${steamId}`,
    },
    openGraph: {
      title,
      description,
      images: profile.avatar?.large ? [profile.avatar.large] : undefined,
    },
    twitter: {
      card: 'summary',
      title,
      description,
      images: profile.avatar?.large ? [profile.avatar.large] : undefined,
    },
  };
}

export default async function PlayerPage({
  params: { steamId },
}: PlayerPageProps) {
  const initialProfile = await getPlayerProfile(steamId);

  return <Home initialProfile={initialProfile} />;
}

import React from 'react';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Home from '@/app/templates/Home';
import getPlayerProfile from '@/lib/getPlayerProfile';
import { SUPPORTED_LOCALES } from '@/locales';

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

  const canonicalPath = `/${locale}/player/${encodeURIComponent(steamId)}`;
  const languages = Object.fromEntries(
    SUPPORTED_LOCALES.map((supported) => [
      supported,
      `/${supported}/player/${encodeURIComponent(steamId)}`,
    ]),
  );
  const images = profile.avatar?.large ? [profile.avatar.large] : undefined;

  return {
    title,
    description,
    alternates: {
      canonical: `https://steam-reveal.vercel.app${canonicalPath}`,
      languages,
    },
    openGraph: {
      title,
      description,
      url: canonicalPath,
      siteName: 'SteamReveal',
      type: 'profile',
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images,
    },
  };
}

export default async function PlayerPage({
  params: { steamId },
}: PlayerPageProps) {
  const initialProfile = await getPlayerProfile(steamId);

  return <Home initialProfile={initialProfile} />;
}

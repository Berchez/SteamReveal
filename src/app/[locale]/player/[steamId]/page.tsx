import React from 'react';
import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import SteamAPI, { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';
import Home from '@/app/templates/Home';

const steam = new SteamAPI(getSteamApiKey() ?? '');

interface PlayerPageProps {
  params: {
    locale: string;
    steamId: string;
  };
}

async function getSteamProfile(
  target: string,
): Promise<UserSummary | undefined> {
  try {
    const steamId = await steam.resolve(target);
    const profile = await steam.getUserSummary(steamId);
    return Array.isArray(profile) ? profile[0] : profile;
  } catch (error) {
    return undefined;
  }
}

export async function generateMetadata({
  params: { locale, steamId },
}: PlayerPageProps): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Metadata.Player' });
  const profile = await getSteamProfile(steamId);

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

export default function PlayerPage() {
  return <Home />;
}

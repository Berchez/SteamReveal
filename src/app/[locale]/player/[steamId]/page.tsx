import React from 'react';
import { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import Home from '@/app/templates/Home';
import getPlayerProfile from '@/lib/getPlayerProfile';
import { SITE_BASE_URL, SUPPORTED_LOCALES } from '@/locales';

export const revalidate = 21600;

// Every Steam profile is generated on demand; an empty list opts the dynamic
// route into the ISR/prerender cache instead of per-request SSR.
export function generateStaticParams() {
  return [];
}

interface PlayerPageProps {
  params: {
    locale: string;
    steamId: string;
  };
}

export async function generateMetadata({
  params: { locale, steamId },
}: PlayerPageProps): Promise<Metadata> {
  setRequestLocale(locale);
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
      canonical: `${SITE_BASE_URL}${canonicalPath}`,
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
      // summary (not summary_large_image): the Steam avatar tops out at
      // 184px and large-image cards want ~300px+ wide — a small image
      // renders poorly or gets discarded, while summary's 144px floor
      // fits exactly.
      card: 'summary',
      title,
      description,
      images,
    },
  };
}

export default async function PlayerPage({
  params: { locale, steamId },
}: PlayerPageProps) {
  setRequestLocale(locale);
  const initialProfile = await getPlayerProfile(steamId);

  return <Home initialProfile={initialProfile} />;
}

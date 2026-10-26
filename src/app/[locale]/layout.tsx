import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import './globals.css';
import 'react-toastify/dist/ReactToastify.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { Roboto, Inknut_Antiqua } from 'next/font/google';
import React from 'react';
import Script from 'next/script';
import HomeProvider from '@/app/templates/Home/HomeProvider';
import SiteNav from '@/app/components/SiteNav/SiteNav';
import ToastProvider from '@/toast.provider';
import { LOCALE_PATHS, SITE_BASE_URL } from '../../locales';

const shouldLoadVercelTelemetry = process.env.VERCEL_ENV === 'production';

const VercelAnalytics = dynamic(
  () => import('@vercel/analytics/react').then((mod) => mod.Analytics),
  { ssr: false, loading: () => null },
);

const VercelSpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((mod) => mod.SpeedInsights),
  { ssr: false, loading: () => null },
);

const roboto = Roboto({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  display: 'swap',
  variable: '--font-roboto',
  weight: ['400', '500', '700'],
});

const inknut = Inknut_Antiqua({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-inknut',
  weight: ['400', '700'],
});

interface RootLayoutProps {
  children: React.ReactNode;
  params: {
    locale: string;
  };
}

export const metadata: Metadata = {
  metadataBase: new URL(SITE_BASE_URL),
  alternates: {
    canonical: `${SITE_BASE_URL}/en`,
    languages: {
      // Bare language codes (no region subtags), matching the player
      // page's own alternates: mixing `en` here with `en-US` there
      // would read as inconsistent clusters to crawlers.
      en: LOCALE_PATHS.en,
      pt: LOCALE_PATHS.pt,
      ru: LOCALE_PATHS.ru,
      de: LOCALE_PATHS.de,
      es: LOCALE_PATHS.es,
      fr: LOCALE_PATHS.fr,
      uk: LOCALE_PATHS.uk,
      pl: LOCALE_PATHS.pl,
    },
  },
  keywords: [
    'osint app',
    'steam profiles',
    'steam profiles search',
    'steam app',
    'OSINT',
    'Steam',
    'SteamReveal',
    'Steam Reveal',
    'steam-reveal',
    'Open Source Intelligence',
    'Profile Analysis',
    'Steam API',
    'Privacy',
    'Public Data',
    'Location',
    'Friends List',
  ],
  title: 'SteamReveal - Analyze Steam Profiles',
  description:
    'SteamReveal is an OSINT tool designed for the Steam community. Analyze Steam profiles, discover real friends, and locate players using public data. Built with a responsive design and multilingual experience',
};

export default function RootLayout({
  children,
  params: { locale },
}: Readonly<RootLayoutProps>) {
  setRequestLocale(locale);
  const messages = useMessages();

  return (
    <html lang={locale} className={`${roboto.variable} ${inknut.variable}`}>
      <head>
        {/* Google AdSense */}
        <Script
          async
          strategy="lazyOnload"
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3301991262958911"
          crossOrigin="anonymous"
        />

        <meta name="google-adsense-account" content="ca-pub-3301991262958911" />

        <meta
          name="google-site-verification"
          content="9bnJzty2EA0iUCoFwiGESzR8VCUnDc33ChIgwb3oj1o"
        />
        <link
          rel="preconnect"
          href="https://avatars.steamstatic.com"
          crossOrigin="anonymous"
        />
        {/*
          next/font does not emit <link rel="preload"> for woff2 on this Next
          version (vercel/next.js#62332), so fonts only start after the fonts
          CSS parses. Preload the latin files used on first paint (Roboto is a
          variable font, one file covers 400/500/700). Rebuild and copy the
          latin *-s.p.woff2 names from .next/static/media if they change.
        */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
          href="/_next/static/media/1e41be92c43b3255-s.p.woff2"
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
          href="/_next/static/media/0d10e58a08c28482-s.p.woff2"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link rel="manifest" href="/site.webmanifest" />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>
            <HomeProvider>
              {/*
                SiteNav is a client island (state comes from /api/site-nav)
                so this layout never reads cookies/headers and player pages
                can stay static/ISR. Its own skeleton paints the fixed shell
                immediately.

                Do NOT reintroduce dynamic(..., { ssr: false }) around this
                tree or a useSearchParams() read in HomeProvider: both bail
                the entire body out to client-only rendering, which strips
                the server-rendered profile/navbar from ISR HTML. Query-param
                reads now live in local Suspense islands instead.
              */}
              <SiteNav />
              {/*
                Fixed-mobile-bar clearance contract: on <sm the navbar is
                a full-width fixed band (~60px) and the layout reserves
                NOTHING for it — every content page under [locale]/
                funnels through Home.tsx, whose branches own the mobile
                clearance (player pt-20, fresh-home pt-8 + MyUserSection
                margin). A future content page that does NOT render Home
                must clear ~60px on mobile itself, or the bar covers its
                top. Do not "fix" this by adding padding here without
                removing Home's, or both pages double-space.
              */}
              {children}
            </HomeProvider>
          </ToastProvider>
        </NextIntlClientProvider>
        {shouldLoadVercelTelemetry && <VercelAnalytics />}
        {shouldLoadVercelTelemetry && <VercelSpeedInsights />}
      </body>
    </html>
  );
}

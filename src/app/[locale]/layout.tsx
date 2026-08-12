import type { Metadata } from 'next';
import './globals.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { Analytics } from '@vercel/analytics/react';
import ToastProvider from '@/toast.provider';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { Roboto, Inknut_Antiqua } from 'next/font/google';
import React from 'react';
import { headers } from 'next/headers';
import Script from 'next/script';
import { LOCALE_PATHS } from '../../locales';

const roboto = Roboto({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-roboto',
  weight: ['400', '700'],
});

const inknut = Inknut_Antiqua({
  subsets: ['latin'],
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
  metadataBase: new URL('https://steam-reveal.vercel.app/'),
  alternates: {
    canonical: 'https://steam-reveal.vercel.app/en',
    languages: {
      'en-US': LOCALE_PATHS.en,
      'pt-BR': LOCALE_PATHS.pt,
      'ru-RU': LOCALE_PATHS.ru,
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
  const messages = useMessages();
  const country = headers().get('x-user-country') || 'UNKNOWN';

  return (
    <html lang={locale} className={`${roboto.variable} ${inknut.variable}`}>
      <head>
        {/* Google AdSense */}
        <Script
          async
          strategy="afterInteractive"
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3301991262958911"
          crossOrigin="anonymous"
        />

        <meta name="google-adsense-account" content="ca-pub-3301991262958911" />
        <meta
          name="google-site-verification"
          content="9bnJzty2EA0iUCoFwiGESzR8VCUnDc33ChIgwb3oj1o"
        />

        {/* Performance quick wins: preconnect fonts + preload LCP poster */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="preload" as="image" href="/images/background.webp" />
      </head>

      <body data-country={country}>
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { Analytics } from '@vercel/analytics/react';
import ToastProvider from '@/toast.provider';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { Roboto, Inknut_Antiqua } from 'next/font/google';
import React from 'react';
import AdSense from '../components/AdSense';
import { headers } from 'next/headers';

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
      'en-US': '/en',
      'pt-BR': '/pt',
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
      <body data-country={country}>
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
        <Analytics />
        <SpeedInsights />
        <AdSense />
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { Analytics } from '@vercel/analytics/react';
import ToastProvider from '@/toast.provider';
import AdSense from '../components/AdSense';
import { SpeedInsights } from '@vercel/speed-insights/next';

interface RootLayoutProps {
  children: React.ReactNode;
  params: {
    locale: string;
  };
}

export const metadata: Metadata = {
  metadataBase: new URL('https://osint-steam.vercel.app/'),
  keywords: [
    'OSINT',
    'Steam',
    'OSINT Steam',
    'Open Source Intelligence',
    'Profile Analysis',
    'Steam API',
    'Privacy',
    'Public Data',
    'Location',
    'Friends List',
  ],
  title: 'OSINT Steam - Analyze Steam Profiles',
  description:
    'OSINT Steam is an OSINT tool designed for the Steam community. Analyze Steam profiles, discover real friends, and locate players using public data. Built with a responsive design and multilingual experience',
};

export default function RootLayout({
  children,
  params: { locale },
}: Readonly<RootLayoutProps>) {
  const messages = useMessages();
  return (
    <html lang={locale}>
      <head>
        <AdSense pId="3301991262958911" />
        <meta name="google-adsense-account" content="ca-pub-3301991262958911" />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}

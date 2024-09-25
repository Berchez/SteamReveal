import type { Metadata } from 'next';
import './globals.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { Analytics } from '@vercel/analytics/react';
import ToastProvider from '@/toast.provider';
import AdSense from '../components/AdSense';
import { SpeedInsights } from '@vercel/speed-insights/next';

export const metadata: Metadata = {
  title: 'OSINT Steam',
  description:
    'OSINT Steam is a comprehensive intelligence platform tailored for the gaming community. Our platform offers a suite of tools and features designed to help gamers collect, analyze, and leverage intelligence from diverse sources across the web, all in one convenient location.',
};

interface RootLayoutProps {
  children: React.ReactNode;
  params: {
    locale: string;
  };
}
export default function RootLayout({
  children,
  params: { locale },
}: Readonly<RootLayoutProps>) {
  const messages = useMessages();
  return (
    <html lang={locale}>
      <head>
        <AdSense pId={process.env.NEXT_PUBLIC_ADSENSE_PID ?? ''} />
        <meta
          name="google-adsense-account"
          content={`ca-pub-${process.env.NEXT_PUBLIC_ADSENSE_PID}`}
        />
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

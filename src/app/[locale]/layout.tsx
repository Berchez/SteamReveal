import type { Metadata } from 'next';
import './globals.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { Analytics } from '@vercel/analytics/react';
import ToastProvider from '@/toast.provider';

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
      <body>
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}

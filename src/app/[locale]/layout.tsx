import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import './globals.css';
import { NextIntlClientProvider, useMessages } from 'next-intl';
import { Roboto, Inknut_Antiqua } from 'next/font/google';
import React, { Suspense } from 'react';
import { cookies, headers } from 'next/headers';
import Script from 'next/script';
import HomeProvider from '@/app/templates/Home/HomeProvider';
import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import SiteNav, {
  siteNavContainerClassName,
} from '@/app/components/SiteNav/SiteNav';
import { WATCH_SESSION_COOKIE } from '@/lib/watch/sessionCookie';
import { LOCALE_PATHS } from '../../locales';

const shouldLoadVercelTelemetry = process.env.VERCEL_ENV === 'production';

const VercelAnalytics = dynamic(
  () => import('@vercel/analytics/react').then((mod) => mod.Analytics),
  { ssr: false, loading: () => null },
);

const VercelSpeedInsights = dynamic(
  () => import('@vercel/speed-insights/next').then((mod) => mod.SpeedInsights),
  { ssr: false, loading: () => null },
);

const ToastProvider = dynamic(
  async () => {
    await import('react-toastify/dist/ReactToastify.css');
    const toastModule = await import('@/toast.provider');
    return toastModule.default;
  },
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
  metadataBase: new URL('https://steam-reveal.vercel.app/'),
  alternates: {
    canonical: 'https://steam-reveal.vercel.app/en',
    languages: {
      'en-US': LOCALE_PATHS.en,
      'pt-BR': LOCALE_PATHS.pt,
      'ru-RU': LOCALE_PATHS.ru,
      'de-DE': LOCALE_PATHS.de,
      'es-ES': LOCALE_PATHS.es,
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
  // Skeleton audience split (read by the Suspense fallback below): the
  // session cookie's PRESENCE — never its value, nothing unsealed here —
  // predicts which cluster will resolve. Absent means the logged-out pill
  // is guaranteed (even the last-resort catch renders logged-out);
  // present usually means the bell+avatar cluster (wrong only for
  // stale/invalid cookies, rare). Before this split the fallback always
  // drew bell+avatar, so every logged-out paint flashed two phantom
  // controls before the sign-in pill landed. Sync read, zero extra I/O,
  // no static-render change (this layout is already dynamic).
  const likelyLoggedIn = cookies().has(WATCH_SESSION_COOKIE);

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
      <body data-country={country}>
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>
            {/*
              useSearchParams() is read inside HomeProvider (anti-loop
              token capture). Next requires a Suspense boundary above it,
              or the whole route bails out to client-only rendering (and
              static prerender fails the build). Dynamic routes resolve
              params without suspending, so this fallback is build-hygiene
              that practically never paints — hence null, not a skeleton.
            */}
            <Suspense fallback={null}>
              <HomeProvider>
                {/*
                SiteNav is async (session + Steam avatar, up to 4s on a
                slow Steam API). Without this boundary the whole route —
                children included — waits for it before streaming a byte.
                Fallback keeps the same fixed wrapper + the switcher (the
                only control that needs no session) PLUS a shape-matched
                placeholder for whichever cluster the session cookie
                predicts (see likelyLoggedIn above): bell + avatar h-11
                circles when a session cookie exists, one h-11 pill when
                it doesn't (the logged-out sign-in shape). Without the
                match the swap pops controls in a beat later — a
                perceptible flash (the old fallback always drew
                bell+avatar, so logged-out paints flashed two phantom
                controls; the liveness Turso read alone is slow enough to
                paint it on most cold loads). Same slots and sizes means
                the swap reads as content loading in, not controls
                appearing. The mobile bar shape (logo placeholder left,
                cluster right) mirrors SiteNav's responsive container for
                the same reason. Pure markup, aria-hidden; the page paints
                instantly and nothing in-flow shifts when the real cluster
                lands (fixed elements never move page content — CLS-safe).
              */}
                <Suspense
                  fallback={
                    <div className={siteNavContainerClassName}>
                      {/* Logo placeholder matches the real logo's box
                          (Link p-1 + 32px image = 40px square) so the
                          swap never shifts the bar's layout. */}
                      <div
                        aria-hidden="true"
                        className="h-10 w-10 animate-pulse rounded bg-gray-700/60 sm:hidden"
                      />
                      <div className="flex items-center gap-2">
                        <LanguageSwitcher />
                        {likelyLoggedIn ? (
                          <>
                            <div
                              aria-hidden="true"
                              className="h-11 w-11 rounded-full bg-gray-700/60 animate-pulse"
                            />
                            <div
                              aria-hidden="true"
                              className="h-11 w-11 rounded-full bg-gray-700/60 animate-pulse"
                            />
                          </>
                        ) : (
                          // Logged-out pill placeholder: h-11 matches the
                          // sign-in pill's height, w-28 approximates its
                          // locale-dependent width (en ~82px … de ~102px)
                          // so the swap barely moves.
                          <div
                            aria-hidden="true"
                            className="h-11 w-28 animate-pulse rounded-full bg-gray-700/60"
                          />
                        )}
                      </div>
                    </div>
                  }
                >
                  <SiteNav locale={locale} />
                </Suspense>
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
            </Suspense>
          </ToastProvider>
        </NextIntlClientProvider>
        {shouldLoadVercelTelemetry && <VercelAnalytics />}
        {shouldLoadVercelTelemetry && <VercelSpeedInsights />}
      </body>
    </html>
  );
}

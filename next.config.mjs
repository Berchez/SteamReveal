import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // The Vercel image optimizer answers EVERY /_next/image request with
    // HTTP 402 (Payment Required) on this deployment: image optimization is
    // not included in the current plan/quota, so the logo, the background
    // poster, the quick-links icons, the QR code and the navbar avatar all
    // fail to load in production (the navbar avatar silently degrades to the
    // letter badge). The images are served straight from their source
    // instead: the local ones from /public, the remote ones from their own
    // CDNs (Steam avatars, flagcdn, the QR service). Nothing here needs
    // resizing at delivery time - the CSS already sizes every usage.
    unoptimized: true,
    domains: ['flagcdn.com', 'avatars.steamstatic.com', 'api.qrserver.com'],
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
        ],
      },
      {
        // Navbar flags (public/flags/*.png): served on EVERY page, but
        // not fingerprinted by Next (public/ assets keep their filename),
        // so without this they revalidate via ETag on each visit. The
        // five files are fixed locale flags whose content never changes —
        // if one is ever swapped, ship it under a new filename.
        source: '/flags/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);

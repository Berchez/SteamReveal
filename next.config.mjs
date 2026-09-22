import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
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

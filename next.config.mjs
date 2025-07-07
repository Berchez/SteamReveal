import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['flagcdn.com', 'avatars.steamstatic.com'],
  },
  experimental: {
    serverComponentsExternalPackages: ['@sparticuz/chromium'],
  },
};

export default withNextIntl(nextConfig);

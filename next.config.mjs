// next.config.js
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

const nextConfig = {
  images: {
    domains: ['flagcdn.com', 'avatars.steamstatic.com'],
  },

  experimental: {
    externalDir: true,
  },

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(typeof config.externals === 'function'
          ? []
          : config.externals),
        '@sparticuz/chromium',
      ];
    }
    return config;
  },
};

export default withNextIntl(nextConfig);

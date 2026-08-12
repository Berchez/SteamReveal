import type { MetadataRoute } from 'next';
import { SUPPORTED_LOCALES } from '../locales';

export default function sitemap(): MetadataRoute.Sitemap {
  const localePages = SUPPORTED_LOCALES.map((locale) => ({
    url: `https://steam-reveal.vercel.app/${locale}`,
    lastModified: new Date(),
  }));

  return [
    {
      url: 'https://steam-reveal.vercel.app/',
      lastModified: new Date(),
      priority: 1,
    },
    ...localePages,
  ];
}

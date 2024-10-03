import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://steam-reveal.vercel.app/',
      lastModified: new Date(),
      priority: 1,
    },
    {
      url: 'https://steam-reveal.vercel.app/en',
      lastModified: new Date(),
    },
    {
      url: 'https://steam-reveal.vercel.app/pt',
      lastModified: new Date(),
    },
  ];
}

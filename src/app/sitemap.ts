import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://osint-steam.vercel.app/',
      lastModified: new Date(),
      priority: 1,
    },
  ];
}

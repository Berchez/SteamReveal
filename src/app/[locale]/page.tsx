import React from 'react';
import { redirect } from 'next/navigation';
import Home from '../templates/Home';

type HomePageProps = {
  params: { locale: string };
  searchParams: Record<string, string | string[] | undefined>;
};

export default function HomePage({ params, searchParams }: HomePageProps) {
  // Backward compatibility: old links used ?player=<steamId>.
  // Redirect to the new route format to avoid breaking existing
  // bookmarks/links that have already been shared.
  const playerParam = searchParams?.player;
  const player = Array.isArray(playerParam) ? playerParam[0] : playerParam;

  if (player) {
    // Preserve every OTHER query param (utm_*, referral tags, etc) — only
    // `player` gets consumed into the path segment. Without this, a link
    // like `/?player=X&utm_source=twitter` would silently drop the utm
    // param on redirect.
    const remainingParams = new URLSearchParams();
    Object.entries(searchParams ?? {}).forEach(([key, value]) => {
      if (key === 'player' || value === undefined) {
        return;
      }
      const values = Array.isArray(value) ? value : [value];
      values.forEach((v) => remainingParams.append(key, v));
    });

    const query = remainingParams.toString();
    // player comes straight from raw query string input, so it must be
    // encoded before being interpolated into a path segment.
    const target = `/${params.locale}/player/${encodeURIComponent(player)}${
      query ? `?${query}` : ''
    }`;

    redirect(target);
  }

  return <Home />;
}

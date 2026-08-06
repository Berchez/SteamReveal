import { useEffect, useState } from 'react';

interface FaceitLinkState {
  url: string;
  isLoading: boolean;
}

const fallbackUrl = (steamId: string) =>
  `https://faceitfinder.com/profile/${encodeURIComponent(steamId)}`;

const useFaceitLink = (steamId: string): FaceitLinkState => {
  const [url, setUrl] = useState<string>(() => fallbackUrl(steamId));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    fetch(`/api/getFaceitLink?steamID=${encodeURIComponent(steamId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        if (!cancelled) setUrl(data.faceitLink ?? fallbackUrl(steamId));
      })
      .catch((error) => {
        console.error('Error fetching Faceit link:', error);
        if (!cancelled) setUrl(fallbackUrl(steamId));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    // Prevents a delayed response from an old Steam ID
    // from overwriting the state after the Steam ID (or the component) has changed.
    return () => {
      cancelled = true;
    };
  }, [steamId]);

  return { url, isLoading };
};

export default useFaceitLink;

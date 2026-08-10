import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';

interface GamersClubNameResponse {
  steamId: string;
  gcName: string | null;
}

interface UseGamersClubNameState {
  name: string | null;
  isLoading: boolean;
  error: string | null;
}

const useGamersClubName = (steamId: string): UseGamersClubNameState => {
  const locale = useLocale();
  const [name, setName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const country = document.body.getAttribute('data-country');
    const isPT = locale?.toLowerCase().startsWith('pt');
    const isBrazil = country === 'BR' || isPT;

    // Skip the request entirely for an empty Steam ID, if the feature is disabled,
    // or if the user is not in Brazil/using PT locale.
    if (!steamId || !isBrazil) {
      setName(null);
      setError(null);
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetch('/api/getGamersClubName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId }),
    })
      .then((res) =>
        res.ok
          ? (res.json() as Promise<GamersClubNameResponse>)
          : Promise.reject(res.status),
      )
      .then((data) => {
        if (!cancelled) {
          setName(data.gcName);
        }
      })
      .catch((fetchError) => {
        // The raw status/error is kept here rather than a hardcoded English
        // sentence — this project is bilingual (next-intl), so the message
        // shown to the user should be decided/translated by the consumer.
        if (!cancelled) {
          setError(String(fetchError));
          setName(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    // Prevents a delayed response from an old Steam ID
    // from overwriting the state after the Steam ID (or the component) has changed.
    return () => {
      cancelled = true;
    };
  }, [steamId]);

  return { name, isLoading, error };
};

export default useGamersClubName;

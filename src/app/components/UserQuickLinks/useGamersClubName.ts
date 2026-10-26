import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { setFriendGcName } from '@/app/templates/Home/shared/analytics/friendGcNameStore';
import { setGcServiceStatus } from '@/app/templates/Home/shared/analytics/gcServiceStatus';
import { getClientCountry } from '@/lib/clientCountry';

interface GamersClubNameResponse {
  steamId: string;
  gcName: string | null;
  /**
   * True when the lookup could not run at all (the local scraper proxy is
   * offline or misconfigured). Distinct from "the player has no GC
   * profile" — the UI holds back the sign-in upsell while this is true.
   */
  unavailable?: boolean;
}

interface UseGamersClubNameState {
  name: string | null;
  isLoading: boolean;
  error: string | null;
  unavailable: boolean;
}

interface UseGamersClubNameOptions {
  /**
   * Lets the caller opt out of the request entirely (e.g. a logged-out
   * friend card that hides GC Name behind the sign-in upsell). Keeping
   * this as an option — instead of a conditional hook call — preserves
   * the Rules of Hooks and still guarantees zero network calls.
   */
  enabled?: boolean;
}

const useGamersClubName = (
  steamId: string,
  { enabled = true }: UseGamersClubNameOptions = {},
): UseGamersClubNameState => {
  const locale = useLocale();
  const [name, setName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled && Boolean(steamId));
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const country = getClientCountry();
    const isPT = locale?.toLowerCase().startsWith('pt');
    const isBrazil = country === 'BR' || isPT;

    // Skip the request entirely for an empty Steam ID or when the caller
    // explicitly disabled the lookup (logged-out premium gating).
    if (!steamId || !enabled) {
      setName(null);
      setError(null);
      setUnavailable(false);
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;
    setError(null);

    // Only show a loading state for Brazil/PT locale users. For everyone else
    // the request still runs (to pick up a cached GC name for BR profiles
    // viewed from abroad), but since the vast majority will resolve to null,
    // we avoid a visible loading flicker by not toggling isLoading for them.
    if (isBrazil) {
      setIsLoading(true);
    }

    fetch('/api/getGamersClubName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId, allowScrape: isBrazil }),
    })
      .then((res) =>
        res.ok
          ? (res.json() as Promise<GamersClubNameResponse>)
          : Promise.reject(res.status),
      )
      .then((data) => {
        if (!cancelled) {
          // Only a CONFIRMED name goes into the shared store (the analytics
          // backfill reads it) — null here is ambiguous (no GC profile vs.
          // a failed/rate-limited scrape) and must never be treated as fact.
          if (data.gcName) {
            setFriendGcName(steamId, data.gcName);
          }
          setName(data.gcName);
          // The API answered, so the scraper is reachable — even when the
          // answer is "no profile". Only an unreachable proxy counts as
          // unavailable.
          const isUnavailable = data.unavailable === true;
          setUnavailable(isUnavailable);
          setGcServiceStatus(isUnavailable ? 'unavailable' : 'available');
        }
      })
      .catch((fetchError) => {
        // The raw status/error is kept here rather than a hardcoded English
        // sentence — this project is bilingual (next-intl), so the message
        // shown to the user should be decided/translated by the consumer.
        if (!cancelled) {
          setError(String(fetchError));
          setName(null);
          // Our own API could not be reached — the GC feature cannot work.
          setUnavailable(true);
          setGcServiceStatus('unavailable');
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
  }, [enabled, locale, steamId]);

  return { name, isLoading, error, unavailable };
};

export default useGamersClubName;

import axios from 'axios';
import { UserSummary } from 'steamapi';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import { locationDataIWant } from '@/@types/locationDataIWant';

// ---- Analytics helpers ---------------------------------------------------

// Moved from useHome.ts without behavioral changes. Kept as a pure module
// (not a hook) because nothing here uses React state or lifecycle — the same
// approach as the existing homeUtils.ts and probabilityMath.ts modules.

export const getRequesterDevice = (): 'mobile' | 'desktop' | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 'mobile'
    : 'desktop';
};

export const getRequesterCountry = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.body.getAttribute('data-country');
};

export const getRequesterBrowserLanguage = (): string | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return navigator.language ?? null;
};

const ANALYTICS_SKIP_PASSWORD_KEY = 'analytics_skip_password';

export const getAnalyticsSkipHeaders = ():
  | Record<string, string>
  | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const skipPassword = localStorage.getItem(ANALYTICS_SKIP_PASSWORD_KEY);

    return skipPassword
      ? { 'x-analytics-skip-password': skipPassword }
      : undefined;
  } catch (e) {
    return undefined;
  }
};

export type AnalyticsMeta = {
  requesterLocale: string | null;
  requesterCountry: string | null;
  requesterBrowserLanguage: string | null;
  device: 'mobile' | 'desktop' | null;
  durationMs: number | null;
};

export const recordAnalytics = async (
  targetInfo: UserSummary | undefined,
  closeFriends: closeFriendsDataIWant[] | undefined,
  possibleLocation: locationDataIWant[] | undefined,
  meta: AnalyticsMeta,
): Promise<string | null> => {
  if (!targetInfo?.steamID) {
    return null;
  }

  let targetGcName: string | null = null;

  try {
    const { data } = await axios.post('/api/getGamersClubName', {
      steamId: targetInfo.steamID,
    });

    targetGcName = data.gcName;
  } catch (e) {
    // Best effort, ignore failures
  }

  try {
    const payload = {
      profile: {
        steamId: targetInfo.steamID,
        steamUrl: targetInfo.url ?? null,
        nickname: targetInfo.nickname ?? null,
        gcName: targetGcName,
        countryCode: targetInfo.countryCode ?? null,
        stateCode: targetInfo.stateCode ?? null,
        cityId: targetInfo.cityID ?? null,
      },

      friends: (closeFriends ?? []).map((f) => ({
        steamId: f.friend.steamID,
        nickname: f.friend.nickname ?? null,
        gcName: null,
        mutualCount: f.count ?? null,
        probability: f.probability ?? null,
        countryCode: f.friend.countryCode ?? null,
      })),

      locationGuess: (possibleLocation ?? []).slice(0, 3).map((l) => ({
        location: l.location,
        probability: l.probability,
      })),

      requesterLocale: meta.requesterLocale,
      requesterCountry: meta.requesterCountry,
      requesterBrowserLanguage: meta.requesterBrowserLanguage,
      device: meta.device,
      durationMs: meta.durationMs,
    };

    const { data } = await axios.post('/api/recordAnalytics', payload, {
      headers: getAnalyticsSkipHeaders(),
    });

    if (data?.skipped) {
      return null;
    }

    return data?.id ?? null;
  } catch (e) {
    console.error('[Analytics] Failed to record search:', e);
    return null;
  }
};

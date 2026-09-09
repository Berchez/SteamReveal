import { UserSummary } from 'steamapi';

interface City {
  id: number;
  name: string;
}

interface BaseState {
  code: string;
  name: string;
}

interface State extends BaseState {
  cities: City[];
}

interface CountryBase {
  code: string;
  name: string;
}

interface Country extends CountryBase {
  states: (State | Omit<BaseState, 'cities'>)[];
}

export interface LocationInfoType {
  country?: Country | Omit<CountryBase, 'states'>;
  state?: State | Omit<BaseState, 'cities'>;
  city?: City;
}

/**
 * `UserSummary` is enriched server-side in /api/getUserInfo (via
 * Object.assign) with an `isCSActive` flag — whether the profile's active
 * game family is Counter-Strike (>=300h OR top playtime) — plus the
 * `gamesSnapshot` it was derived from. Client code gates
 * the automatic cheater-probability prefetch on it, and the analytics
 * payload (recordAnalytics) recomputes the flag from the snapshot, so both
 * are part of the official profile shape rather than ad-hoc inline casts.
 * The SSR seed path (getPlayerProfile) must populate both as well —
 * otherwise a direct /player/[steamId] load records isCSActive=false
 * unconditionally (empty snapshot) and the dashboard counter freezes.
 */
export interface EnrichedUserSummary extends UserSummary {
  isCSActive?: boolean;
  gamesSnapshot?: Array<{ name: string; playtimeHours: number }>;
}

type targetInfoJsonType =
  | {
      profileInfo: EnrichedUserSummary;
      targetLocationInfo: LocationInfoType;
    }
  | undefined;

export default targetInfoJsonType;

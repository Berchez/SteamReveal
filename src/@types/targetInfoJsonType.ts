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
 * game family is Counter-Strike (>=300h OR top playtime). Client code gates
 * the automatic cheater-probability prefetch on it, so it's part of the
 * official profile shape rather than an ad-hoc inline cast.
 */
export interface EnrichedUserSummary extends UserSummary {
  isCSActive?: boolean;
}

type targetInfoJsonType =
  | {
      profileInfo: EnrichedUserSummary;
      targetLocationInfo: LocationInfoType;
    }
  | undefined;

export default targetInfoJsonType;

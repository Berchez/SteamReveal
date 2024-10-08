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

type targetInfoJsonType =
  | {
      profileInfo: UserSummary;
      targetLocationInfo: LocationInfoType;
    }
  | undefined;

export default targetInfoJsonType;

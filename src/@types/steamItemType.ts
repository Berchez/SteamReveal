/* eslint-disable @typescript-eslint/no-explicit-any */
export type SteamItem = {
  appid: number;
  classid: string;
  instanceid: string;
  currency: number;
  background_color: string;
  icon_url: string;
  descriptions: Array<Record<string, any>>;
  tradable: number;
  actions: Array<Record<string, any>>;
  name: string;
  name_color: string;
  type: string;
  market_name: string;
  market_hash_name: string;
  market_actions: Array<Record<string, any>>;
  commodity: number;
  market_tradable_restriction: number;
  market_marketable_restriction: number;
  marketable: number;
  tags: Array<Record<string, any>>;
};

import { SteamItem } from '@/@types/steamItemType';
import axios from 'axios';

const CS2_ID = 730;
const CONTEXT_ID = 2;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const fetchInventoryPage = async (
  steamId: string,
  startAssetId: string | null,
  allDescriptions: SteamItem[] = [],
): Promise<SteamItem[]> => {
  const count = 900;
  const url = `https://steamcommunity.com/inventory/${steamId}/${CS2_ID}/${CONTEXT_ID}?l=english&count=${count}${startAssetId ? `&start_assetid=${startAssetId}` : ''}`;

  try {
    const { data } = await axios.get(url);

    if (!data?.descriptions) return allDescriptions;

    allDescriptions.push(...data.descriptions);

    if (data.more_items === 1 || data.more_items === true) {
      await sleep(500);
      return fetchInventoryPage(steamId, data.last_assetid, allDescriptions);
    }

    return allDescriptions;
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      if (status === 403)
        throw new Error('Inventory is private or SteamID/AppID is invalid.');
      if (status === 429) {
        console.warn('Too many requests. Retrying in 10 seconds...');
        await sleep(10000);
        return fetchInventoryPage(steamId, startAssetId, allDescriptions);
      }

      throw error;
    }

    throw new Error('Unknown error occurred.');
  }
};

const getInventory = async (steamId: string): Promise<SteamItem[]> =>
  fetchInventoryPage(steamId, null);

export default getInventory;

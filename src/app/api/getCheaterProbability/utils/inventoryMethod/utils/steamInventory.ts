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
  retryCount = 0,
): Promise<SteamItem[]> => {
  const count = 900;
  const url = `https://steamcommunity.com/inventory/${steamId}/${CS2_ID}/${CONTEXT_ID}?l=english&count=${count}${startAssetId ? `&start_assetid=${startAssetId}` : ''}`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (inventory-fetcher)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!data?.descriptions) return allDescriptions;

    allDescriptions.push(...data.descriptions);

    if (data.more_items === 1 || data.more_items === true) {
      await sleep(1500);
      return fetchInventoryPage(
        steamId,
        data.last_assetid,
        allDescriptions,
        0, // reset retry
      );
    }

    return allDescriptions;
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      if (status === 403) {
        throw new Error('Inventory is private or SteamID/AppID is invalid.');
      }

      if (status === 429) {
        const MAX_RETRIES = 5;
        const baseDelay = 2000; // 2s

        if (retryCount >= MAX_RETRIES) {
          throw new Error('Too many requests (429). Retry limit reached.');
        }

        const delay = baseDelay * 2 ** retryCount;
        console.warn(
          `429 detected. Retrying in ${delay / 1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})`,
        );

        await sleep(delay);

        return fetchInventoryPage(
          steamId,
          startAssetId,
          allDescriptions,
          retryCount + 1,
        );
      }

      throw error;
    }

    throw new Error('Unknown error occurred.');
  }
};

const getInventory = async (steamId: string): Promise<SteamItem[]> =>
  fetchInventoryPage(steamId, null);

export default getInventory;

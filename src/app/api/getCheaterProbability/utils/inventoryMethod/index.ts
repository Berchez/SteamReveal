import getInventory from './utils/steamInventory';
import { calculateInventoryScore, normalizeScoreTo10 } from './utils/score';

const classifyInventory = async (steamId: string): Promise<number> => {
  try {
    const items = await getInventory(steamId);
    const score = calculateInventoryScore(items);
    return normalizeScoreTo10(score);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Execution failed: ${error.message}`);
    } else {
      console.error('Unknown error:', error);
    }
    return 0;
  }
};

export default classifyInventory;

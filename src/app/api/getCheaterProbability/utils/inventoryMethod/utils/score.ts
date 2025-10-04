import { SteamItem } from '@/@types/steamItemType';
import { getItemRarity, rarityWeights } from './rarity';

export const calculateInventoryScore = (items: SteamItem[]): number => {
  let score = 0;

  items.forEach((item) => {
    const rarity = getItemRarity(item);
    score += rarityWeights[rarity] || 0;
  });

  return score;
};

export const normalizeScoreTo10 = (score: number): number => {
  const maxScore = 100;
  return Math.min(10, +((score / maxScore) * 10).toFixed(2));
};

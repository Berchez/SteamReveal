import { SteamItem } from '@/@types/steamItemType';

export const rarityWeights: Record<string, number> = {
  Gold: 8,
  Red: 5,
  Pink: 3,
  Purple: 2,
  Blue: 1,
  Gray: 0,
  Other: 0,
};

export const getItemRarity = (item: SteamItem): string => {
  const type = item.type.toLowerCase();

  if (type.includes('contraband') || type.includes('exceedingly rare'))
    return 'Gold';
  if (type.includes('covert')) return 'Red';
  if (type.includes('classified')) return 'Pink';
  if (type.includes('restricted')) return 'Purple';
  if (type.includes('mil-spec')) return 'Blue';
  if (type.includes('consumer')) return 'Gray';

  return 'Other';
};

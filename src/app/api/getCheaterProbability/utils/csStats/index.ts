import axios from 'axios';
import * as cheerio from 'cheerio';

interface CsStats {
  leetifyRating: string;
  kd: string;
  headAccuracy: string;
  winrate: string;
  totalMatches: string;
  killsPerRound: string;
  spottedAccuracy: string;
  timeToDamage: string;
  sprayAccuracy: string;
}

const normalize = (value?: string): string => {
  if (!value) return '';
  return value.trim().toUpperCase() === 'N/A' ? '' : value.trim();
};

const getCsStats = async (target: string): Promise<CsStats | null> => {
  try {
    const url = `https://cswat.ch/stats/${target}`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    // --- Leetify Rating ---
    const leetifyRating = normalize($('svg text').first().text());

    // --- Cards grid ---
    const cards: Record<string, string> = {};
    $('.grid.grid-cols-2.lg\\:grid-cols-4.gap-2 > div').each((_, el) => {
      const label = $(el).find('span.text-sm').text().trim();
      const value = normalize($(el).find('span.text-2xl').text());
      if (label) {
        cards[label] = value;
      }
    });

    // --- Final return ---
    const stats: CsStats = {
      leetifyRating,
      kd: normalize(cards['K/D']),
      headAccuracy: normalize(cards['Head Accuracy']),
      winrate: normalize(cards.Winrate),
      totalMatches: normalize(cards['Total Matches']),
      killsPerRound: normalize(cards['Kills per Round']),
      spottedAccuracy: normalize(cards['Spotted Accuracy *']),
      timeToDamage: normalize(cards['Time to Damage']),
      sprayAccuracy: normalize(cards['Spray Accuracy']),
    };

    return stats;
  } catch (error) {
    console.error('Error getting csstats:', error);
    return null;
  }
};

export default getCsStats;

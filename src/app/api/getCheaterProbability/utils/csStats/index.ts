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

const getCsStats = async (target: string): Promise<CsStats | null> => {
  try {
    const url = `https://cswat.ch/stats/${target}`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    // --- Leetify Rating ---
    const leetifyRating = $('svg text').first().text().trim();

    // --- Cards grid ---
    const cards: Record<string, string> = {};
    $('.grid.grid-cols-2.lg\\:grid-cols-4.gap-2 > div').each((_, el) => {
      const label = $(el).find('span.text-sm').text().trim();
      const value = $(el).find('span.text-2xl').text().trim();
      if (label && value) {
        cards[label] = value;
      }
    });

    // --- Final return ---
    const stats: CsStats = {
      leetifyRating,
      kd: cards['K/D'] || '',
      headAccuracy: cards['Head Accuracy'] || '',
      winrate: cards['Winrate'] || '',
      totalMatches: cards['Total Matches'] || '',
      killsPerRound: cards['Kills per Round'] || '',
      spottedAccuracy: cards['Spotted Accuracy *'] || '',
      timeToDamage: cards['Time to Damage'] || '',
      sprayAccuracy: cards['Spray Accuracy'] || '',
    };

    return stats;
  } catch (error) {
    console.error('Error getting csstats:', error);
    return null;
  }
};

export default getCsStats;

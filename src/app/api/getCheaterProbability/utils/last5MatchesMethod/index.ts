import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const getLast5MatchesRating = async (
  steamID: string,
): Promise<number | null> => {
  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: (chromium as any).headless
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/114.0.0.0 Safari/537.36',
    );

    const url = `https://csstats.gg/player/${steamID}#/matches`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30 * 1000 });

    const ratings = await page.$$eval(
      '#player-matches table tbody tr',
      (rows) =>
        rows
          .slice(0, 5)
          .map((row) => {
            const ratingTd = row.querySelectorAll('td')[19];
            if (!ratingTd) return null;

            const ratingStr = ratingTd.textContent?.trim();
            return ratingStr ? parseFloat(ratingStr) : null;
          })
          .filter((rating) => typeof rating === 'number') as number[],
    );

    const average =
      ratings.length > 0
        ? ratings.reduce((sum, val) => sum + val, 0) / ratings.length
        : 0;

    return average;
  } catch (err) {
    console.error(`Erro ao buscar últimas 5 partidas de ${steamID}:`, err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
};

export default getLast5MatchesRating;

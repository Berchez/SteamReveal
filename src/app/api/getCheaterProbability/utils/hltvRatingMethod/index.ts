import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const getHLTVRating = async (steamID: string): Promise<number | null> => {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: (chromium as any).headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/114.0.0.0 Safari/537.36',
    );

    await page.goto(`https://csstats.gg/player/${steamID}`, {
      waitUntil: 'networkidle0',
      timeout: 30 * 1000,
    });

    await page.waitForSelector('#rating span', { timeout: 15 * 1000 });

    const ratingText = await page.$eval(
      '#rating span',
      (el) => el.textContent?.trim() ?? '',
    );

    const rating = parseFloat(ratingText);
    return Number.isNaN(rating) ? null : rating;
  } catch (err) {
    console.error(`Erro ao buscar HLTV Rating para ${steamID}:`, err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
};

export default getHLTVRating;

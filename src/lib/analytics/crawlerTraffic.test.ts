import { isCrawlerUserAgent } from './crawlerTraffic';

describe('isCrawlerUserAgent', () => {
  it('flags the classic shared-link fetchers (Facebook, Twitter, Slack, Discord)', () => {
    expect(
      isCrawlerUserAgent(
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      ),
    ).toBe(true);
    expect(isCrawlerUserAgent('Facebot')).toBe(true);
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (compatible; Meta-ExternalAgent/1.1; +https://developers.facebook.com/docs/sharing/webmasters/crawler)',
      ),
    ).toBe(true);
    expect(isCrawlerUserAgent('Twitterbot/1.0')).toBe(true);
    expect(
      isCrawlerUserAgent('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'),
    ).toBe(true);
    expect(isCrawlerUserAgent('Discordbot/2.0')).toBe(true);
  });

  it('flags search-engine spiders', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      ),
    ).toBe(true);
    expect(isCrawlerUserAgent('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe(true);
    expect(isCrawlerUserAgent('DuckDuckBot/1.0')).toBe(true);
    // Sogou spider forms only — see the no-false-positives test below.
    expect(
      isCrawlerUserAgent(
        'Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)',
      ),
    ).toBe(true);
    expect(
      isCrawlerUserAgent(
        'Sogou Orion spider/3.0(+http://www.sogou.com/docs/help/webmasters.htm#07)',
      ),
    ).toBe(true);
    expect(isCrawlerUserAgent('Pinterestbot/1.0')).toBe(true);
  });

  it('flags AI search crawlers', () => {
    expect(isCrawlerUserAgent('GPTBot/1.2')).toBe(true);
    expect(isCrawlerUserAgent('OAI-SearchBot/1.0')).toBe(true);
    expect(isCrawlerUserAgent('ClaudeBot/1.0')).toBe(true);
    expect(isCrawlerUserAgent('PerplexityBot/1.0')).toBe(true);
    expect(isCrawlerUserAgent('AhrefsBot/7.0')).toBe(true);
    expect(isCrawlerUserAgent('SemrushBot/7~bl')).toBe(true);
    expect(isCrawlerUserAgent('Bytespider')).toBe(true);
  });

  it('mirrors the robots.txt AI policy (training + answer agents + opt-outs)', () => {
    // Same source (src/lib/crawlers.ts): an agent blocked from crawling
    // must also be skipped if it fires the beacon.
    expect(isCrawlerUserAgent('FacebookBot/1.0')).toBe(true);
    expect(
      isCrawlerUserAgent('Claude-User/1.0'),
    ).toBe(true);
    expect(isCrawlerUserAgent('Perplexity-User/1.0')).toBe(true);
    expect(
      isCrawlerUserAgent('meta-externalfetcher/1.1'),
    ).toBe(true);
    expect(isCrawlerUserAgent('CCBot/2.0')).toBe(true);
    expect(isCrawlerUserAgent('Google-Extended')).toBe(true);
    expect(
      isCrawlerUserAgent('WhatsApp/2.24.5.78 Android/14'),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isCrawlerUserAgent('FACEBOOKEXTERNALHIT/1.1')).toBe(true);
    expect(isCrawlerUserAgent('facebookcatalog/1.0')).toBe(true);
  });

  it('flags generic automation markers', () => {
    expect(isCrawlerUserAgent('MyCrawler/1.0')).toBe(true);
    expect(isCrawlerUserAgent('some-scraper (contact@example.com)')).toBe(true);
  });

  it('lets real browsers through (Chrome, Firefox, Safari, mobile)', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    // Safari Technology Preview contains "Preview" — must NOT match
    // (bare 'preview' is deliberately not a token).
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari Technology Preview/19620.1.10',
      ),
    ).toBe(false);
    // SogouMobileBrowser is a real mobile browser — bare 'sogou' would
    // match it, which is exactly why only the spider forms are tokens.
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Linux; U; Android 12; zh-CN; V2165A Build/SP1A.210812.003) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36 SogouMobileBrowser/7.12.0',
      ),
    ).toBe(false);
  });

  it('lets unknown, empty and non-string UAs through (denylist, never allowlist)', () => {
    // curl / node (smoke scripts) / privacy-stripped browsers keep recording.
    expect(isCrawlerUserAgent('curl/8.0.1')).toBe(false);
    expect(isCrawlerUserAgent('node')).toBe(false);
    expect(isCrawlerUserAgent('')).toBe(false);
    expect(isCrawlerUserAgent(null)).toBe(false);
    expect(isCrawlerUserAgent(undefined)).toBe(false);
    expect(isCrawlerUserAgent(42)).toBe(false);
  });
});

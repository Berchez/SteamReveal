/**
 * @jest-environment node
 *
 * Sitemap route tests (P0 SEO): the safety net of the feature — success
 * serves static homes plus demand-ordered player entries, and ANY read
 * failure (rejection or hang-budget race) degrades LOUDLY to the static
 * homes with an ops-log trace instead of failing the crawl.
 */

import sitemap from './sitemap';
import { listPopularProfiles } from '@/lib/analytics/db';
import logRouteError from '@/lib/logRouteError';

jest.mock('@/lib/analytics/db', () => ({
  listPopularProfiles: jest.fn(),
}));

jest.mock('@/lib/logRouteError', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockListPopularProfiles = listPopularProfiles as jest.MockedFunction<
  typeof listPopularProfiles
>;
const mockLogRouteError = logRouteError as jest.Mock;

describe('sitemap route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves static homes plus demand-ordered player entries', async () => {
    mockListPopularProfiles.mockResolvedValue([
      {
        steamId: '76561198000000001',
        nickname: 'SomePlayer',
        lastSearchedAt: '2026-09-25T00:00:00.000Z',
        searchCount: 7,
      },
    ]);

    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);

    expect(urls).toContain('https://steam-reveal.vercel.app/');
    expect(urls).toContain('https://steam-reveal.vercel.app/en');
    expect(urls).toContain(
      'https://steam-reveal.vercel.app/en/player/76561198000000001',
    );
    expect(mockListPopularProfiles).toHaveBeenCalledWith(10000, 0, 3, 2);
    expect(mockLogRouteError).not.toHaveBeenCalled();
  });

  it('degrades loudly to static-only entries when the read fails', async () => {
    mockListPopularProfiles.mockRejectedValue(new Error('Turso is down'));

    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);

    // Crawlers keep a valid sitemap: homes survive, player pages heal on
    // the next revalidation window.
    expect(urls).toContain('https://steam-reveal.vercel.app/');
    expect(urls).toContain('https://steam-reveal.vercel.app/pt');
    expect(urls.some((url) => url.includes('/player/'))).toBe(false);
    // ...with a durable trace (not just a Vercel function log nobody
    // watches): a sitemap stuck on static-only must be noticeable.
    expect(mockLogRouteError).toHaveBeenCalledTimes(1);
    expect(mockLogRouteError.mock.calls[0][0]).toBe('sitemap');
  });
});

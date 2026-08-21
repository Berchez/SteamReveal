// src/app/[locale]/player/[steamId]/page.test.ts
import { generateMetadata } from './page';

const mockResolve = jest.fn();
const mockGetUserSummary = jest.fn();

jest.mock('steamapi', () => {
  return jest.fn().mockImplementation(() => ({
    resolve: (target: string) => mockResolve(target),
    getUserSummary: (steamId: string) => mockGetUserSummary(steamId),
  }));
});

jest.mock('next-intl/server', () => ({
  getTranslations: jest.fn(async () => (key: string, vars?: any) => {
    const map: Record<string, string> = {
      title: `Analyze ${vars?.nickname}'s Steam Profile`,
      description: `See ${vars?.nickname}'s data`,
      fallbackTitle: 'SteamReveal - Analyze Steam Profiles',
      fallbackDescription: 'SteamReveal is an OSINT tool...',
    };
    return map[key];
  }),
}));

describe('generateMetadata for /player/[steamId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns personalized metadata when profile resolves', async () => {
    mockResolve.mockResolvedValue('76561198146931523');
    mockGetUserSummary.mockResolvedValue({
      nickname: 'TestUser',
      avatar: { large: 'https://example.com/avatar.jpg' },
    });

    const metadata = await generateMetadata({
      params: { locale: 'en', steamId: 'testuser' },
    });

    expect(metadata.title).toContain('TestUser');
    expect(metadata.openGraph?.images).toEqual([
      'https://example.com/avatar.jpg',
    ]);
  });

  it('falls back to default metadata when resolve fails', async () => {
    mockResolve.mockRejectedValue(new Error('Invalid target'));

    const metadata = await generateMetadata({
      params: { locale: 'en', steamId: 'invalid' },
    });

    expect(metadata.title).toBe('SteamReveal - Analyze Steam Profiles');
  });
});

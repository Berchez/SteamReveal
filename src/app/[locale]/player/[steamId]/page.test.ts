// src/app/[locale]/player/[steamId]/page.test.ts
import { UserSummary } from 'steamapi';
import { generateMetadata } from './page';
import getPlayerProfile from '@/lib/getPlayerProfile';

const mockGetPlayerProfile = getPlayerProfile as jest.MockedFunction<
  typeof getPlayerProfile
>;

jest.mock('../../../../lib/getPlayerProfile', () => ({
  __esModule: true,
  default: jest.fn(),
}));

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
    mockGetPlayerProfile.mockResolvedValue({
      nickname: 'TestUser',
      avatar: {
        large: 'https://example.com/avatar.jpg',
        medium: '',
        small: '',
        hash: '',
      },
    } as UserSummary);

    const metadata = await generateMetadata({
      params: {
        locale: 'en',
        steamId: 'testuser',
      },
    });

    expect(metadata.title).toContain('TestUser');

    expect(metadata.openGraph?.images).toEqual([
      'https://example.com/avatar.jpg',
    ]);
  });

  it('falls back to default metadata when profile lookup fails', async () => {
    mockGetPlayerProfile.mockResolvedValue(undefined);

    const metadata = await generateMetadata({
      params: {
        locale: 'en',
        steamId: 'invalid',
      },
    });

    expect(metadata.title).toBe('SteamReveal - Analyze Steam Profiles');
  });
});

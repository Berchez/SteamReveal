import { resolveBotProfileUrl } from './botProfile';

describe('resolveBotProfileUrl', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds the community URL for a valid bot id', () => {
    process.env.STEAM_BOT_STEAMID = '76561199000000001';

    expect(resolveBotProfileUrl()).toBe(
      'https://steamcommunity.com/profiles/76561199000000001',
    );
  });

  it.each([[''], ['short'], ['7656119900000000a'], [undefined]])(
    'returns null for missing/invalid ids (%p) instead of a broken link',
    (value) => {
      if (value === undefined) delete process.env.STEAM_BOT_STEAMID;
      else process.env.STEAM_BOT_STEAMID = value as string;

      expect(resolveBotProfileUrl()).toBeNull();
    },
  );
});

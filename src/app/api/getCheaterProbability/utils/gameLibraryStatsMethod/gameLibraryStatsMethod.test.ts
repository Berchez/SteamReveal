import getGameLibraryStats from './index';

// SteamAPI mock
const mockGetUserOwnedGames = jest.fn();

jest.mock('steamapi', () => {
  // Returns a constructor that creates objects with getUserOwnedGames mocked
  return jest.fn().mockImplementation(() => ({
    getUserOwnedGames: (...args: any[]) => mockGetUserOwnedGames(...args),
  }));
});

describe('getGameLibraryStats', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns CS2 minutes if CS2 exists', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 730 }, minutes: 1200 },
    ]);
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: 1200, totalGamesCount: 1 });
    expect(mockGetUserOwnedGames).toHaveBeenCalledWith('123456789');
  });

  it('returns -1 if CS2 not found', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 570 }, minutes: 500 },
    ]);
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: -1, totalGamesCount: 1 });
  });

  it('returns -1 if response is not an array', async () => {
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    mockGetUserOwnedGames.mockResolvedValue({ invalid: 'data' } as any);
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: -1, totalGamesCount: -1 });
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('returns -1 if SteamAPI throws', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetUserOwnedGames.mockRejectedValue(new Error('API error'));
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: -1, totalGamesCount: -1 });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

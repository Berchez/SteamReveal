import getGameLibraryStats from './index';

// SteamAPI mock
const mockGetUserOwnedGames = jest.fn();
const mockGetUserSummary = jest.fn();

jest.mock('steamapi', () => {
  // Returns a constructor that creates objects with getUserOwnedGames and
  // getUserSummary mocked
  return jest.fn().mockImplementation(() => ({
    getUserOwnedGames: (...args: any[]) => mockGetUserOwnedGames(...args),
    getUserSummary: (...args: any[]) => mockGetUserSummary(...args),
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

  it('treats library-wide zero playtime on a non-fresh account as masked (-1)', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 730 }, minutes: 0 },
      { game: { id: 570 }, minutes: undefined },
    ]);
    mockGetUserSummary.mockResolvedValue({
      createdAt: new Date('2010-01-01'),
    });
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: -1, totalGamesCount: 2 });
    expect(mockGetUserSummary).toHaveBeenCalledWith('123456789');
  });

  it('keeps genuine 0 when the whole library is zero but the account is brand new', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 730 }, minutes: 0 },
      { game: { id: 570 }, minutes: 0 },
    ]);
    mockGetUserSummary.mockResolvedValue({ createdAt: new Date() });
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: 0, totalGamesCount: 2 });
  });

  it('keeps 0 when the age lookup fails (conservative)', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 730 }, minutes: 0 },
    ]);
    mockGetUserSummary.mockRejectedValue(new Error('summary failed'));
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: 0, totalGamesCount: 1 });
    consoleErrorSpy.mockRestore();
  });

  it('keeps a genuine CS2 zero when other games have real playtime', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 730 }, minutes: 0 },
      { game: { id: 570 }, minutes: 500 },
    ]);
    mockGetUserSummary.mockResolvedValue({
      createdAt: new Date('2010-01-01'),
    });
    const result = await getGameLibraryStats('123456789');
    expect(result).toEqual({ playTime: 0, totalGamesCount: 2 });
    expect(mockGetUserSummary).not.toHaveBeenCalled();
  });
});
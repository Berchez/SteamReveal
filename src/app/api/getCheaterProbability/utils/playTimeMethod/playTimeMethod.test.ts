// src/app/api/getCheaterProbability/utils/playTimeMethod/playTimeMethod.test.ts
import getPlayTimeScore from './index';

// Mock do SteamAPI
const mockGetUserOwnedGames = jest.fn();

jest.mock('steamapi', () => {
  // Retorna um construtor que cria objetos com getUserOwnedGames mockado
  return jest.fn().mockImplementation(() => ({
    getUserOwnedGames: (...args: any[]) => mockGetUserOwnedGames(...args),
  }));
});

describe('getPlayTimeScore', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns CS2 minutes if CS2 exists', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 730 }, minutes: 1200 },
    ]);
    const result = await getPlayTimeScore('123456789');
    expect(result).toBe(1200);
    expect(mockGetUserOwnedGames).toHaveBeenCalledWith('123456789');
  });

  it('returns 0 if CS2 not found', async () => {
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { id: 570 }, minutes: 500 },
    ]);
    const result = await getPlayTimeScore('123456789');
    expect(result).toBe(0);
  });

  it('returns -1 if response is not an array', async () => {
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    mockGetUserOwnedGames.mockResolvedValue({ invalid: 'data' } as any);
    const result = await getPlayTimeScore('123456789');
    expect(result).toBe(-1);
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('returns -1 if SteamAPI throws', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetUserOwnedGames.mockRejectedValue(new Error('API error'));
    const result = await getPlayTimeScore('123456789');
    expect(result).toBe(-1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

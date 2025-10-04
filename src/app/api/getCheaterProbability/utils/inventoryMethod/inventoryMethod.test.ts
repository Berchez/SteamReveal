import getInventoryScore from './index';
import getInventory from './utils/steamInventory';
import * as scoreUtils from './utils/score';

jest.mock('./utils/steamInventory');
jest.mock('./utils/score', () => ({
  calculateInventoryScore: jest.fn(),
  normalizeScoreTo10: jest.fn(),
}));

const targetToTest = '76561198146333375';

describe('getInventoryScore', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should return normalized score based on inventory', async () => {
    (getInventory as jest.Mock).mockResolvedValue([
      { type: 'Contraband Knife' },
      { type: 'Covert Rifle' },
      { type: 'Consumer Pistol' },
    ]);

    (scoreUtils.calculateInventoryScore as jest.Mock).mockReturnValue(14);
    (scoreUtils.normalizeScoreTo10 as jest.Mock).mockReturnValue(1.4);

    const score = await getInventoryScore(targetToTest);

    expect(getInventory).toHaveBeenCalledWith(targetToTest);
    expect(scoreUtils.calculateInventoryScore).toHaveBeenCalledWith([
      { type: 'Contraband Knife' },
      { type: 'Covert Rifle' },
      { type: 'Consumer Pistol' },
    ]);
    expect(scoreUtils.normalizeScoreTo10).toHaveBeenCalledWith(14);
    expect(score).toBe(1.4);
  });

  it('should return 0 if getInventory throws an error', async () => {
    (getInventory as jest.Mock).mockRejectedValue(new Error('Steam error'));

    const score = await getInventoryScore(targetToTest);

    expect(getInventory).toHaveBeenCalledWith(targetToTest);
    expect(score).toBe(0);
  });

  it('should log unknown errors and return 0', async () => {
    (getInventory as jest.Mock).mockRejectedValue('Some unknown error');

    const score = await getInventoryScore(targetToTest);

    expect(score).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Unknown error:',
      'Some unknown error',
    );
  });
});

jest.mock('./utils/getProfileComments', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import getBadCommentsScore from './index';
import getProfileComments from './utils/getProfileComments';

jest.mock('./utils/getProfileComments');
jest.mock('./utils/badWords', () => ['cheater', 'hack', 'toxic']);

const targetToTest = '76561198146333375';

describe('getBadCommentsScore', () => {
  const mockedGetProfileComments = getProfileComments as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 0 when there are no comments', async () => {
    mockedGetProfileComments.mockResolvedValueOnce([]);
    const score = await getBadCommentsScore(targetToTest);
    expect(score).toBe(0);
  });

  it('returns 0 when no bad words are found in comments', async () => {
    mockedGetProfileComments.mockResolvedValueOnce([
      { author: 'User1', text: 'Nice profile!' },
      { author: 'User2', text: 'Good game!' },
    ]);
    const score = await getBadCommentsScore(targetToTest);
    expect(score).toBe(0);
  });

  it('counts occurrences of a single bad word', async () => {
    mockedGetProfileComments.mockResolvedValueOnce([
      { author: 'User1', text: 'You are a cheater!' },
    ]);
    const score = await getBadCommentsScore(targetToTest);
    expect(score).toBe(1);
  });

  it('counts multiple bad words in one comment', async () => {
    mockedGetProfileComments.mockResolvedValueOnce([
      { author: 'User1', text: 'Cheater and hack detected!' },
    ]);
    const score = await getBadCommentsScore(targetToTest);
    // "cheater" + "hack" = 2
    expect(score).toBe(2);
  });

  it('counts multiple occurrences across different comments', async () => {
    mockedGetProfileComments.mockResolvedValueOnce([
      { author: 'User1', text: 'Cheater!' },
      { author: 'User2', text: 'This guy is hack hack!' },
      { author: 'User3', text: 'So toxic, very toxic!' },
    ]);
    const score = await getBadCommentsScore(targetToTest);
    // "cheater" = 1, "hack hack" = 2, "toxic toxic" = 2 → total 5
    expect(score).toBe(5);
  });

  it('is case insensitive when matching bad words', async () => {
    mockedGetProfileComments.mockResolvedValueOnce([
      { author: 'User1', text: 'CHEATER and HaCk!' },
    ]);
    const score = await getBadCommentsScore(targetToTest);
    expect(score).toBe(2);
  });
});

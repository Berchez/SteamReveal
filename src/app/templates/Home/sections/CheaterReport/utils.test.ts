import { CheaterDataType } from '@/@types/cheaterDataType';
import analyzeCheaterData from './utils';

const makeFeatureObject = (
  overrides: Partial<CheaterDataType['featureObject']> = {},
): CheaterDataType['featureObject'] => ({
  badCommentsScore: -1,
  bannedFriendsScore: -1,
  inventoryScore: -1,
  playTimeScore: -1,
  userLevel: -1,
  csStats: null as never,
  analyzedFriendsCount: 0,
  platformBanScore: 0,
  ...overrides,
});

const makeData = (
  featureObject: CheaterDataType['featureObject'],
  cheaterProbability = 0.7,
): CheaterDataType => ({
  cheaterProbability,
  featureObject,
});

const makeTranslator = () => {
  const lookup: Record<string, string> = {
    platformBannedFaceit: 'Banned on FACEIT',
    platformBannedGamersClub: 'Banned on Gamers Club',
    platformSmurfedFaceit: 'Banned on FACEIT for smurfing',
    platformSmurfedGamersClub: 'Banned on Gamers Club for smurfing',
  };
  return (key: string) => lookup[key] ?? key;
};

const noBan = {
  faceit: { banned: false, reason: null, classification: null },
  gamersClub: { banned: false, reason: null, classification: null },
};

describe('analyzeCheaterData - platform ban', () => {
  it('does not add a platform-ban reason when not banned anywhere', () => {
    const result = analyzeCheaterData(
      makeData(
        makeFeatureObject({ platformBanScore: 0, platformBanDetails: noBan }),
      ),
      makeTranslator() as never,
    );

    expect(result.suspicionReasons).toHaveLength(0);
  });

  it('adds a Faceit-specific suspicion reason when banned for cheating on FACEIT', () => {
    const result = analyzeCheaterData(
      makeData(
        makeFeatureObject({
          platformBanScore: 1,
          platformBanCheatCount: 1,
          platformBanSmurfCount: 0,
          platformBanOtherCount: 0,
          platformBanDetails: {
            faceit: {
              banned: true,
              reason: 'Cheating',
              classification: 'cheat',
            },
            gamersClub: { banned: false, reason: null, classification: null },
          },
        }),
      ),
      makeTranslator() as never,
    );

    expect(result.suspicionReasons).toContain('Banned on FACEIT');
    expect(result.suspicionReasons).not.toContain('Banned on Gamers Club');
    expect(result.innocenceReasons).not.toContain('Banned on FACEIT for smurfing');
  });

  it('adds one suspicion reason per platform when banned for cheating on both', () => {
    const result = analyzeCheaterData(
      makeData(
        makeFeatureObject({
          platformBanScore: 2,
          platformBanCheatCount: 2,
          platformBanSmurfCount: 0,
          platformBanOtherCount: 0,
          platformBanDetails: {
            faceit: {
              banned: true,
              reason: 'Cheating',
              classification: 'cheat',
            },
            gamersClub: {
              banned: true,
              reason: 'Gamers Club Anti-Cheat',
              classification: 'cheat',
            },
          },
        }),
      ),
      makeTranslator() as never,
    );

    expect(result.suspicionReasons).toContain('Banned on FACEIT');
    expect(result.suspicionReasons).toContain('Banned on Gamers Club');
  });

  it('adds a GamersClub-specific innocence reason when banned for smurfing', () => {
    const result = analyzeCheaterData(
      makeData(
        makeFeatureObject({
          platformBanScore: -1,
          platformBanCheatCount: 0,
          platformBanSmurfCount: 1,
          platformBanOtherCount: 0,
          platformBanDetails: {
            faceit: { banned: false, reason: null, classification: null },
            gamersClub: {
              banned: true,
              reason: 'smurfing',
              classification: 'smurf',
            },
          },
        }),
      ),
      makeTranslator() as never,
    );

    expect(result.innocenceReasons).toContain(
      'Banned on Gamers Club for smurfing',
    );
    expect(result.suspicionReasons).not.toContain('Banned on Gamers Club');
  });

  it('shows BOTH suspicion and innocence reasons for a mixed cheat+smurf case', () => {
    const result = analyzeCheaterData(
      makeData(
        makeFeatureObject({
          platformBanScore: 0, // 1 cheat - 1 smurf
          platformBanCheatCount: 1,
          platformBanSmurfCount: 1,
          platformBanOtherCount: 0,
          platformBanDetails: {
            faceit: {
              banned: true,
              reason: 'Cheating',
              classification: 'cheat',
            },
            gamersClub: {
              banned: true,
              reason: 'smurfing',
              classification: 'smurf',
            },
          },
        }),
      ),
      makeTranslator() as never,
    );

    expect(result.suspicionReasons).toContain('Banned on FACEIT');
    expect(result.suspicionReasons).not.toContain('Banned on Gamers Club');
    expect(result.innocenceReasons).toContain(
      'Banned on Gamers Club for smurfing',
    );
  });

  it('stays neutral (no reason) for an "other" ban', () => {
    const result = analyzeCheaterData(
      makeData(
        makeFeatureObject({
          platformBanScore: 0,
          platformBanCheatCount: 0,
          platformBanSmurfCount: 0,
          platformBanOtherCount: 1,
          platformBanDetails: {
            faceit: { banned: false, reason: null, classification: null },
            gamersClub: {
              banned: true,
              reason: 'Some other reason',
              classification: 'other',
            },
          },
        }),
      ),
      makeTranslator() as never,
    );

    expect(result.innocenceReasons).not.toContain(
      'Banned on Gamers Club for smurfing',
    );
    expect(result.suspicionReasons).not.toContain('Banned on Gamers Club');
  });
});

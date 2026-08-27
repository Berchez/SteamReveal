import {
  computeCloseFriendsProbability,
  computeCityScores,
  computeLocationProbabilities,
} from './probabilityMath';

function makeFriend(
  steamID: string,
  count: number,
  extra: Record<string, unknown> = {},
) {
  return {
    friend: { steamID, nickname: steamID, ...extra },
    count,
  } as any;
}

describe('computeCloseFriendsProbability', () => {
  it('returns [] for empty input (previously crashed when reading closeFriends[0].count)', () => {
    expect(computeCloseFriendsProbability([])).toEqual([]);
  });

  it('does not crash with fewer than 5 items (previously always assumed 5+)', () => {
    const input = [makeFriend('a', 10), makeFriend('b', 5)];
    const result = computeCloseFriendsProbability(input);
    expect(result).toHaveLength(2);
    result.forEach((r) => {
      expect(Number.isFinite(r.probability)).toBe(true);
    });
  });

  it('does not crash with a single item (biggestCountValue === the item itself)', () => {
    const input = [makeFriend('a', 10)];
    const result = computeCloseFriendsProbability(input);
    expect(result).toHaveLength(1);
    expect(Number.isFinite(result[0].probability)).toBe(true);
  });

  it('gives 100 probability to the friend with the highest count', () => {
    const input = [
      makeFriend('a', 100),
      makeFriend('b', 10),
      makeFriend('c', 1),
    ];
    const result = computeCloseFriendsProbability(input);
    expect(result[0].probability).toBeCloseTo(100);
  });

  it('preserves the friend and count fields unchanged', () => {
    const input = [makeFriend('a', 10, { nickname: 'Alice' })];
    const result = computeCloseFriendsProbability(input);
    expect(result[0].friend).toEqual(input[0].friend);
    expect(result[0].count).toBe(10);
  });

  it('never exceeds 100 even with an extreme outlier', () => {
    const input = [
      makeFriend('a', 10000),
      makeFriend('b', 1),
      makeFriend('c', 1),
      makeFriend('d', 1),
      makeFriend('e', 1),
    ];
    const result = computeCloseFriendsProbability(input);
    expect(result[0].probability).toBeLessThanOrEqual(100);
  });

  it('does not produce NaN/Infinity when all counts are 0', () => {
    const input = [makeFriend('a', 0), makeFriend('b', 0)];
    const result = computeCloseFriendsProbability(input);
    result.forEach((r) => {
      expect(Number.isFinite(r.probability)).toBe(true);
    });
  });
});

describe('computeCityScores', () => {
  it('ignores friends without a resolved city', () => {
    const input = [makeFriend('a', 10, { cityID: undefined })];
    expect(computeCityScores(input)).toEqual({});
  });

  it('uses the countryCode/stateCode/cityID key', () => {
    const input = [
      makeFriend('a', 10, { countryCode: 'US', stateCode: 'CA', cityID: 5 }),
    ];
    expect(computeCityScores(input)).toEqual({ 'US/CA/5': 10 });
  });

  it('multiplies (does not add) scores when multiple friends share the same city', () => {
    const input = [
      makeFriend('a', 10, { countryCode: 'US', stateCode: 'CA', cityID: 5 }),
      makeFriend('b', 3, { countryCode: 'US', stateCode: 'CA', cityID: 5 }),
    ];
    expect(computeCityScores(input)).toEqual({ 'US/CA/5': 30 });
  });
});

describe('computeLocationProbabilities', () => {
  it('returns probability 0 for everyone when the total score is 0', () => {
    const input = [{ location: {}, count: 0 }];
    const result = computeLocationProbabilities(input);
    expect(result[0].probability).toBe(0);
  });

  it('gives a higher probability to the location with the largest share of the total score', () => {
    const input = [
      { location: { cityName: 'A' }, count: 90 },
      { location: { cityName: 'B' }, count: 10 },
    ];
    const result = computeLocationProbabilities(input);
    expect(result[0].probability).toBeGreaterThan(result[1].probability);
  });

  it('preserves the location object unchanged', () => {
    const location = { cityName: 'A', countryCode: 'BR' };
    const input = [{ location, count: 10 }];
    const result = computeLocationProbabilities(input);
    expect(result[0].location).toBe(location);
  });
});

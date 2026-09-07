import {
  parseRecordBody,
  parseCheaterBody,
  parseFriendGcNamesBody,
} from './input';

describe('parseRecordBody', () => {
  it('parses a full valid payload', () => {
    const input = parseRecordBody({
      profile: {
        steamId: '76561198000000000',
        steamUrl: 'https://steamcommunity.com/id/x',
        nickname: 'Alice',
        gcName: 'aliceCS',
        countryCode: 'BR',
        stateCode: 'SP',
        cityId: 7679,
      },
      friends: [{ steamId: '76561198000000001', mutualCount: 2 }],
      gamesSnapshot: [{ name: 'CS2', playtimeHours: 100 }],
      isCSActive: true,
      requesterLocale: 'pt',
      requesterCountry: 'br',
      requesterBrowserLanguage: 'pt-BR',
      device: 'desktop',
      locationGuess: [{ location: { cityName: 'São Paulo' }, probability: 0.9 }],
      durationMs: 1500,
    });

    expect(input).not.toBeNull();
    expect(input?.profile.cityId).toBe(7679);
    expect(input?.friends).toHaveLength(1);
    expect(input?.device).toBe('desktop');
    expect(input?.durationMs).toBe(1500);
  });

  it('returns null when profile or steamId is missing', () => {
    expect(parseRecordBody(null)).toBeNull();
    expect(parseRecordBody({ profile: {} })).toBeNull();
    expect(parseRecordBody({ profile: { steamId: '' } })).toBeNull();
  });

  it('falls back gracefully on wrong-typed optional fields', () => {
    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      friends: 'not-an-array',
      device: 'smartwatch',
      durationMs: 'fast',
      requesterCountry: 42,
    });

    expect(input).not.toBeNull();
    expect(input?.friends).toEqual([]);
    expect(input?.device).toBeNull();
    expect(input?.durationMs).toBeNull();
    expect(input?.requesterCountry).toBeNull();
  });

  it('drops malformed items inside otherwise-valid arrays', () => {
    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      friends: [
        { steamId: '76561198000000001', nickname: 'Bom' },
        { steamId: '' },
        { nickname: 'sem-id' },
        'lixo',
      ],
      gamesSnapshot: [
        { name: 'CS2', playtimeHours: 100 },
        { name: '' },
        { name: 'sem-playtime' },
        { playtimeHours: 50 },
      ],
      locationGuess: [
        { location: { cityName: 'SP' }, probability: 0.9 },
        { probability: 0.5 },
        'lixo',
      ],
    });

    expect(input?.friends).toEqual([
      { steamId: '76561198000000001', nickname: 'Bom' },
    ]);
    expect(input?.gamesSnapshot).toEqual([{ name: 'CS2', playtimeHours: 100 }]);
    expect(input?.locationGuess).toEqual([
      { location: { cityName: 'SP' }, probability: 0.9 },
    ]);
  });

  it('caps oversized arrays to the defensive bound', () => {
    // Unique valid Steam64 ids so the cap is what's exercised, not the
    // per-item format filter.
    const friends = Array.from({ length: 2000 }, (_, i) => ({
      steamId: String(76561198000000000 + i),
    }));
    const gamesSnapshot = Array.from({ length: 2000 }, (_, i) => ({
      name: `g${i}`,
      playtimeHours: 1,
    }));
    const locationGuess = Array.from({ length: 2000 }, (_, i) => ({
      location: { cityName: `c${i}` },
      probability: 0.5,
    }));

    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      friends,
      gamesSnapshot,
      locationGuess,
    });

    expect(input?.friends).toHaveLength(1000);
    expect(input?.gamesSnapshot).toHaveLength(1000);
    expect(input?.locationGuess).toHaveLength(10);
  });

  it('drops friends with wrong-typed optional fields', () => {
    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      friends: [
        { steamId: '76561198000000001', nickname: 'Ok', mutualCount: 2 },
        { steamId: '76561198000000002', mutualCount: 'three' },
        { steamId: '76561198000000003', probability: 'high' },
        { steamId: '76561198000000004', nickname: 42 },
        { steamId: '76561198000000005', countryCode: true },
        { steamId: '76561198000000006', gcName: null, probability: 0.5 },
      ],
    });

    expect(input?.friends).toEqual([
      { steamId: '76561198000000001', nickname: 'Ok', mutualCount: 2 },
      { steamId: '76561198000000006', gcName: null, probability: 0.5 },
    ]);
  });

  it('drops friends with out-of-range or non-finite probability', () => {
    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      friends: [
        { steamId: '76561198000000001', probability: 100 },
        { steamId: '76561198000000002', probability: 0 },
        { steamId: '76561198000000003', probability: -1 },
        { steamId: '76561198000000004', probability: 101 },
        { steamId: '76561198000000005', probability: 101.5 },
        { steamId: '76561198000000006', probability: NaN },
        { steamId: '76561198000000007' },
      ],
    });

    // Only 0/100/undefined survive; every other value is unusable confidence.
    expect(input?.friends).toEqual([
      { steamId: '76561198000000001', probability: 100 },
      { steamId: '76561198000000002', probability: 0 },
      { steamId: '76561198000000007' },
    ]);
  });

  it('drops friends whose steamId is not a Steam64 id', () => {
    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      friends: [
        { steamId: '   ' },
        { steamId: 'x'.repeat(65) },
        { steamId: '7656119800000000' },
        { steamId: '765611980000000001' },
        { steamId: '76561198000000abc' },
        { steamId: 76561198000000001 },
        { steamId: '76561198000000001' },
      ],
    });

    expect(input?.friends).toEqual([{ steamId: '76561198000000001' }]);
  });

  it('rejects profile steamIds that are not Steam64 ids', () => {
    expect(parseRecordBody({ profile: { steamId: '' } })).toBeNull();
    expect(parseRecordBody({ profile: { steamId: '7656119800000000' } })).toBeNull();
    expect(parseRecordBody({ profile: { steamId: 'alice' } })).toBeNull();
    expect(
      parseRecordBody({ profile: { steamId: '76561198000000000' } }),
    ).not.toBeNull();
  });

  it('drops location guesses with wrong-typed or oversized nested fields', () => {
    const input = parseRecordBody({
      profile: { steamId: '76561198000000000' },
      locationGuess: [
        { location: { cityName: 'SP' }, probability: 0.9 },
        { location: { cityName: 123 }, probability: 0.5 },
        { location: { countryCode: 'x'.repeat(2001) }, probability: 0.5 },
        { location: null, probability: 0.5 },
        { location: { cityName: 'RJ' }, probability: 'high' },
        { location: { cityName: 'out-of-range' }, probability: 150 },
        { location: { cityName: 'negative' }, probability: -1 },
        { location: { cityName: 'top-endpoint' }, probability: 100 },
      ],
    });

    expect(input?.locationGuess).toEqual([
      { location: { cityName: 'SP' }, probability: 0.9 },
      { location: { cityName: 'top-endpoint' }, probability: 100 },
    ]);
  });
});

describe('parseCheaterBody', () => {
  it('parses a valid cheater payload', () => {
    expect(
      parseCheaterBody({
        searchId: '1788564056404-tzx2nt',
        score: 42,
        bannedFriendsCount: 3,
      }),
    ).toEqual({
      searchId: '1788564056404-tzx2nt',
      score: 42,
      bannedFriendsCount: 3,
    });
  });

  it('accepts a missing bannedFriendsCount as null', () => {
    expect(parseCheaterBody({ searchId: 'x', score: 10 })).toEqual({
      searchId: 'x',
      score: 10,
      bannedFriendsCount: null,
    });
  });

  it('accepts any finite score within 0-100 (both 0-1 fractions and percentages)', () => {
    expect(parseCheaterBody({ searchId: 'x', score: 0 })).not.toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: 0.5 })).not.toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: 99.99 })).not.toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: 100 })).not.toBeNull();
  });

  it('rejects out-of-range or non-finite scores', () => {
    expect(parseCheaterBody({ searchId: 'x', score: -1 })).toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: 100.5 })).toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: 101 })).toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: NaN })).toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: Infinity })).toBeNull();
  });

  it('returns null when searchId is missing or score is not a number', () => {
    expect(parseCheaterBody({ score: 10 })).toBeNull();
    expect(parseCheaterBody({ searchId: 'x', score: 'high' })).toBeNull();
  });
});

describe('parseFriendGcNamesBody', () => {
  const steamId = '76561198000000001';

  it('parses a valid list of confirmed names', () => {
    expect(
      parseFriendGcNamesBody({
        searchId: '1788564056404-tzx2nt',
        gcNames: [{ steamId, gcName: 'João CS' }],
      }),
    ).toEqual({
      searchId: '1788564056404-tzx2nt',
      gcNames: [{ steamId, gcName: 'João CS' }],
    });
  });

  it('returns null when searchId is missing or the body is not an object', () => {
    expect(parseFriendGcNamesBody(null)).toBeNull();
    expect(parseFriendGcNamesBody([])).toBeNull();
    expect(parseFriendGcNamesBody({ gcNames: [] })).toBeNull();
    expect(parseFriendGcNamesBody({ searchId: '' })).toBeNull();
    expect(parseFriendGcNamesBody({ searchId: 42, gcNames: [] })).toBeNull();
  });

  it('accepts a missing/non-array gcNames as an empty batch', () => {
    expect(parseFriendGcNamesBody({ searchId: 'x' })).toEqual({
      searchId: 'x',
      gcNames: [],
    });
    expect(parseFriendGcNamesBody({ searchId: 'x', gcNames: 'nope' })).toEqual({
      searchId: 'x',
      gcNames: [],
    });
  });

  it('drops entries with invalid steamIds or blank/oversized names', () => {
    expect(
      parseFriendGcNamesBody({
        searchId: 'x',
        gcNames: [
          { steamId, gcName: 'Ok' },
          { steamId: '  ', gcName: 'Blank' }, // invalid steamId
          { steamId, gcName: '   ' }, // blank name (nothing confirmed)
          { steamId: '7656119800000000', gcName: 'short-id' }, // 16 digits
          { steamId: 42, gcName: 'not-string' }, // wrong type
          { steamId, gcName: 'x'.repeat(2001) }, // oversized name
          'lixo', // not an object
          null, // not an object
        ],
      }),
    ).toEqual({
      searchId: 'x',
      gcNames: [{ steamId, gcName: 'Ok' }],
    });
  });

  it('caps the batch at the defensive bound', () => {
    const gcNames = Array.from({ length: 2000 }, (_, i) => ({
      steamId: String(76561198000000000 + i),
      gcName: `name-${i}`,
    }));

    expect(
      parseFriendGcNamesBody({ searchId: 'x', gcNames })?.gcNames,
    ).toHaveLength(1000);
  });
});
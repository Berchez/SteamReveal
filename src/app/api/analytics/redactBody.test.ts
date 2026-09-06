import redactBodyForLog from './redactBody';

describe('redactBodyForLog', () => {
  it('masks the profile steamId down to its last 4 digits and counts arrays', () => {
    const redacted = redactBodyForLog({
      profile: {
        steamId: '76561198000000123',
        steamUrl: 'https://steamcommunity.com/id/alice',
        nickname: 'Alice',
        gcName: 'aliceCS',
        countryCode: 'BR',
      },
      friends: [
        { steamId: '76561198000000001', nickname: 'Bob' },
        { steamId: '76561198000000002' },
      ],
      gamesSnapshot: [{ name: 'CS2', playtimeHours: 100 }],
      locationGuess: [
        { location: { cityName: 'São Paulo' }, probability: 0.9 },
        { location: { cityName: 'Rio' }, probability: 0.5 },
      ],
      isCSActive: true,
      device: 'desktop',
      durationMs: 1500,
    });

    expect(redacted).toEqual({
      steamId: '…0123',
      friendCount: 2,
      gamesCount: 1,
      locationGuessCount: 2,
    });
    expect(JSON.stringify(redacted)).not.toContain('76561198000000123');
    expect(JSON.stringify(redacted)).not.toContain('Alice');
    expect(JSON.stringify(redacted)).not.toContain('Bob');
    expect(JSON.stringify(redacted)).not.toContain('76561198000000001');
  });

  it('keeps the server-generated searchId and score from the cheater body', () => {
    expect(
      redactBodyForLog({
        searchId: '1788564056404-tzx2nt',
        score: 42,
        bannedFriendsCount: 3,
      }),
    ).toEqual({ searchId: '1788564056404-tzx2nt', score: 42 });
  });

  it('drops undefined fields instead of serializing them as null', () => {
    const redacted = redactBodyForLog({ profile: { steamId: '76561198000009999' } });

    expect(JSON.stringify(redacted)).toBe('{"steamId":"…9999"}');
  });

  it('describes non-object bodies by type without echoing content', () => {
    expect(redactBodyForLog(null)).toEqual({ bodyType: 'null' });
    expect(redactBodyForLog('some-huge-string')).toEqual({
      bodyType: 'string',
    });
    expect(redactBodyForLog(42)).toEqual({ bodyType: 'number' });
  });
});
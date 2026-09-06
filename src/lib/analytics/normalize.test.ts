import {
  filterValidFriends,
  filterValidGames,
  filterValidLocations,
} from './normalize';

import type { FriendRecord, GameSnapshotEntry, LocationGuess } from './types';

describe('filterValidFriends', () => {
  it('keeps friends with a valid steamId and drops junk', () => {
    const friends = [
      { steamId: '76561198000000001', nickname: 'Keep' },
      { steamId: '', nickname: 'Empty' },
      { steamId: '   ', nickname: 'Whitespace' },
      { steamId: '9'.repeat(65), nickname: 'Too long' },
      { steamId: null, nickname: 'Null id' },
      { nickname: 'No id' },
    ] as unknown as FriendRecord[];

    expect(filterValidFriends(friends)).toEqual([
      { steamId: '76561198000000001', nickname: 'Keep' },
    ]);
  });
});

describe('filterValidGames', () => {
  it('keeps games with a name and finite playtime', () => {
    const games = [
      { name: 'CS2', playtimeHours: 120.5 },
      { name: '  ', playtimeHours: 5 },
      { name: '', playtimeHours: 5 },
      { name: 'No playtime' },
      { name: 'NaN', playtimeHours: NaN },
      { name: 'Infinity', playtimeHours: Infinity },
      { name: 'x'.repeat(2001), playtimeHours: 1 },
    ] as unknown as GameSnapshotEntry[];

    const kept = filterValidGames(games);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEqual({ name: 'CS2', playtimeHours: 120.5 });
  });
});

describe('filterValidLocations', () => {
  it('keeps guesses with a finite probability and an object location', () => {
    const guesses = [
      { location: { cityName: 'SP' }, probability: 87.5 },
      { location: { cityName: 'No probability' } },
      { probability: 0.5 },
      { location: null, probability: 0.5 },
      { location: { cityName: 'NaN' }, probability: NaN },
    ] as unknown as LocationGuess[];

    const kept = filterValidLocations(guesses);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEqual({ location: { cityName: 'SP' }, probability: 87.5 });
  });

  it('drops guesses whose probability is outside the 0–100 scale', () => {
    const guesses = [
      { location: { cityName: 'top' }, probability: 100 },
      { location: { cityName: 'bottom' }, probability: 0 },
      { location: { cityName: 'over' }, probability: 100.5 },
      { location: { cityName: 'negative' }, probability: -0.1 },
      { location: { cityName: 'inf' }, probability: Infinity },
    ] as unknown as LocationGuess[];

    expect(filterValidLocations(guesses)).toEqual([
      { location: { cityName: 'top' }, probability: 100 },
      { location: { cityName: 'bottom' }, probability: 0 },
    ]);
  });
});

describe('filterValidFriends', () => {
  it('drops friends whose probability is outside the 0–100 scale (absent is fine)', () => {
    const friends = [
      { steamId: '76561198000000001' },
      { steamId: '76561198000000002', probability: 42 },
      { steamId: '76561198000000003', probability: 101 },
      { steamId: '76561198000000004', probability: -5 },
      { steamId: '76561198000000005', probability: NaN },
      { steamId: '76561198000000006', probability: null },
    ] as unknown as FriendRecord[];

    const kept = filterValidFriends(friends);
    expect(kept.map((f) => f.steamId)).toEqual([
      '76561198000000001',
      '76561198000000002',
      '76561198000000006',
    ]);
  });
});
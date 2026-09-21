import { STEAM_ID64_RE, isSteamId64 } from './steamId';

describe('isSteamId64', () => {
  it('accepts well-formed 17-digit ids', () => {
    expect(isSteamId64('76561198000000001')).toBe(true);
    expect(isSteamId64('76561197960265728')).toBe(true);
  });

  it('accepts the full individual range, not just the 7656119 prefix', () => {
    // Universe-1 individual accounts span 76561197960…76561202255…
    // (accountid fills 32 bits) — a prefix check would wrongly reject
    // high account ids, so any 17-digit string is valid here.
    expect(isSteamId64('76561202255233023')).toBe(true);
    expect(isSteamId64('10000000000000000')).toBe(true);
  });

  it('rejects malformed and non-string values', () => {
    for (const bad of [
      '',
      'short',
      '7656119800000000',
      '765611980000000011',
      '7656119800000000a',
      ' 76561198000000001',
      '76561198000000001 ',
      76561198000000001,
      null,
      undefined,
    ]) {
      expect(isSteamId64(bad)).toBe(false);
    }
  });

  it('exposes the shared pattern', () => {
    expect(STEAM_ID64_RE).toEqual(/^\d{17}$/);
  });
});

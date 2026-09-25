import {
  STEAM_ID64_RE,
  isSteamId64,
  isPlausibleSteamId64,
  isOutOfSpanNumericId,
} from './steamId';

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

describe('isOutOfSpanNumericId (shared entry-layer guard)', () => {
  it('flags 17-digit numbers outside the span', () => {
    expect(isOutOfSpanNumericId('44846128515546448')).toBe(true);
    expect(isOutOfSpanNumericId('99999999999999999')).toBe(true);
  });

  it('clears in-range ids and every non-17-digit input', () => {
    expect(isOutOfSpanNumericId('76561198000000001')).toBe(false);
    expect(isOutOfSpanNumericId('76561202255233023')).toBe(false);
    expect(isOutOfSpanNumericId('some-vanity-url')).toBe(false);
    expect(isOutOfSpanNumericId('12345')).toBe(false);
    expect(isOutOfSpanNumericId('')).toBe(false);
    expect(isOutOfSpanNumericId(null)).toBe(false);
  });
});

describe('isPlausibleSteamId64 (entry-validation range check)', () => {
  it('accepts the entire individual range, including its exact bounds', () => {
    // Range check, not a prefix check: the highest accountids
    // (76561202255…) must pass just like the canonical 7656119… ones.
    expect(isPlausibleSteamId64('76561197960265728')).toBe(true);
    expect(isPlausibleSteamId64('76561198000000001')).toBe(true);
    expect(isPlausibleSteamId64('76561202255233023')).toBe(true);
  });

  it('rejects 17-digit numbers outside the span (can never be a profile)', () => {
    expect(isPlausibleSteamId64('76561197960265727')).toBe(false);
    expect(isPlausibleSteamId64('76561202255233024')).toBe(false);
    // The exact production garbage from the ops log (2026-09: a user
    // searched this and burned a 500 + Bad Request logs).
    expect(isPlausibleSteamId64('44846128515546448')).toBe(false);
    expect(isPlausibleSteamId64('10000000000000000')).toBe(false);
  });

  it('rejects non-strings and wrong shapes without throwing', () => {
    for (const bad of ['', 'short', '7656119800000000', 42, null, undefined]) {
      expect(() => isPlausibleSteamId64(bad)).not.toThrow();
      expect(isPlausibleSteamId64(bad)).toBe(false);
    }
  });
});

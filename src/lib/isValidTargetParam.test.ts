import isValidTargetParam from './isValidTargetParam';

describe('isValidTargetParam', () => {
  it('accepts a non-empty string', () => {
    expect(isValidTargetParam('some-vanity-url')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidTargetParam('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isValidTargetParam('   ')).toBe(false);
  });

  it.each([undefined, null, 42, {}, [], true])(
    'rejects non-string value: %p',
    (value) => {
      expect(isValidTargetParam(value)).toBe(false);
    },
  );

  it('accepts in-range 17-digit SteamID64s (vanity semantics untouched)', () => {
    expect(isValidTargetParam('76561198000000001')).toBe(true);
    expect(isValidTargetParam('76561202255233023')).toBe(true);
  });

  it('rejects 17-digit numbers outside the SteamID64 span before any Steam call', () => {
    // The exact production garbage from the 2026-09 ops log: it used to
    // pass validation, ride resolve()'s 17-digit pass-through, and come
    // back as a 500 "No players found" + "Bad Request" error logs.
    expect(isValidTargetParam('44846128515546448')).toBe(false);
    expect(isValidTargetParam('99999999999999999')).toBe(false);
  });

  it('still lets short numerics and vanity names through (resolve() judges those)', () => {
    expect(isValidTargetParam('12345')).toBe(true);
    expect(isValidTargetParam('some-vanity')).toBe(true);
  });
});

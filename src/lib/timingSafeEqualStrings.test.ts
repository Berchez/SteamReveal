import timingSafeEqualStrings from './timingSafeEqualStrings';

describe('timingSafeEqualStrings', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualStrings('secret', 'secret')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqualStrings('secret', 'sfcret')).toBe(false);
  });

  it('returns false for strings of different length without throwing', () => {
    expect(() =>
      timingSafeEqualStrings('short', 'a-much-longer-string'),
    ).not.toThrow();
    expect(timingSafeEqualStrings('short', 'a-much-longer-string')).toBe(false);
  });

  it('compares multi-byte (unicode) strings correctly', () => {
    expect(timingSafeEqualStrings('sénhá-🔒', 'sénhá-🔒')).toBe(true);
    expect(timingSafeEqualStrings('sénhá-🔒', 'sénhá-🔓')).toBe(false);
  });
});

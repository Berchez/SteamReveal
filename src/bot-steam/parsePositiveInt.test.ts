import parsePositiveInt from './parsePositiveInt';

describe('parsePositiveInt', () => {
  it('returns the parsed integer for valid input', () => {
    expect(parsePositiveInt('60000', 'BOT_FOO_MS')).toBe(60000);
    expect(parsePositiveInt('1', 'BOT_FOO_MS')).toBe(1);
  });

  it('returns undefined for missing or empty input (caller applies fallback)', () => {
    expect(parsePositiveInt(undefined, 'BOT_FOO_MS')).toBeUndefined();
    expect(parsePositiveInt('', 'BOT_FOO_MS')).toBeUndefined();
  });

  it.each([
    ['0'],
    ['-5'],
    ['-1'],
    ['not-a-number'],
    ['NaN'],
    ['Infinity'],
    ['1.5'],
    ['0.5'],
  ])('throws naming the variable for %s', (raw) => {
    expect(() => parsePositiveInt(raw, 'BOT_FOO_MS')).toThrow('BOT_FOO_MS');
  });

  it('parses Number-compatible input (whitespace padding is tolerated)', () => {
    // Number() trims surrounding whitespace — tolerated, not rejected.
    // This test pins the behavior so a future strictness change is deliberate.
    expect(parsePositiveInt('  42  ', 'BOT_FOO_MS')).toBe(42);
  });
});

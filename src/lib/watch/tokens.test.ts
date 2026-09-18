import {
  generateHexToken,
  isWatchTokenShape,
  WATCH_TOKEN_BYTES,
  WATCH_TOKEN_HEX_LENGTH,
} from './tokens';

describe('generateHexToken', () => {
  it('mints 64 lowercase hex chars by default (the only raw-token shape)', () => {
    const token = generateHexToken();

    expect(token).toMatch(
      new RegExp(`^[0-9a-f]{${WATCH_TOKEN_HEX_LENGTH}}$`),
    );
    expect(WATCH_TOKEN_BYTES).toBe(32);
    expect(WATCH_TOKEN_HEX_LENGTH).toBe(WATCH_TOKEN_BYTES * 2);
  });

  it('scales with the byte length and never repeats', () => {
    expect(generateHexToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(generateHexToken()).not.toBe(generateHexToken());
  });

  it.each([0, -1, 1.5, Number.NaN, '32' as unknown as number])(
    'throws on a non-positive-integer length (%p) instead of minting short',
    (byteLength) => {
      expect(() => generateHexToken(byteLength)).toThrow(/positive integer/);
    },
  );
});

describe('isWatchTokenShape', () => {
  it('accepts exactly what the issuer mints (and nothing else)', () => {
    expect(isWatchTokenShape(generateHexToken())).toBe(true);
    // A different byte length mints a different shape — the gate tracks
    // the constant, not a literal.
    expect(isWatchTokenShape(generateHexToken(16))).toBe(false);
  });

  it('rejects probes, punctuation, wrong lengths and non-strings', () => {
    expect(isWatchTokenShape('nope')).toBe(false);
    expect(isWatchTokenShape('ab'.repeat(32) + '.')).toBe(false);
    expect(isWatchTokenShape('ab'.repeat(31))).toBe(false);
    expect(isWatchTokenShape('ab'.repeat(33))).toBe(false);
    expect(isWatchTokenShape('AB'.repeat(32))).toBe(false);
    expect(isWatchTokenShape('')).toBe(false);
    expect(isWatchTokenShape(null)).toBe(false);
    expect(isWatchTokenShape(undefined)).toBe(false);
    expect(isWatchTokenShape(42)).toBe(false);
  });
});

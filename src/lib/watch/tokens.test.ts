import { generateHexToken, WATCH_TOKEN_BYTES } from './tokens';

describe('generateHexToken', () => {
  it('mints 64 lowercase hex chars by default (the only raw-token shape)', () => {
    const token = generateHexToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(WATCH_TOKEN_BYTES).toBe(32);
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

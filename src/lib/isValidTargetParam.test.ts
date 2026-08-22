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
});

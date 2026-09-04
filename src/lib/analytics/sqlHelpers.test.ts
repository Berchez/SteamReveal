import { toSqlBool, nullableText } from './sqlHelpers';

describe('toSqlBool', () => {
  it('maps true/false to 1/0 and absent values to null', () => {
    expect(toSqlBool(true)).toBe(1);
    expect(toSqlBool(false)).toBe(0);
    expect(toSqlBool(null)).toBeNull();
    expect(toSqlBool(undefined)).toBeNull();
  });
});

describe('nullableText', () => {
  it('passes strings through and coerces numbers to TEXT', () => {
    expect(nullableText('2786')).toBe('2786');
    expect(nullableText(2786)).toBe('2786');
    expect(nullableText(0)).toBe('0');
    expect(nullableText('')).toBe('');
  });

  it('keeps NULL for absent values', () => {
    expect(nullableText(null)).toBeNull();
    expect(nullableText(undefined)).toBeNull();
  });
});
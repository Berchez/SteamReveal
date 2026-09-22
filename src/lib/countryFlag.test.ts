import {
  countryDisplayName,
  flagImageUrl,
  normalizeCountryCode,
} from './countryFlag';

describe('normalizeCountryCode', () => {
  it('uppercases valid 2-letter codes (write-path, DAL and UI contract)', () => {
    expect(normalizeCountryCode('br')).toBe('BR');
    expect(normalizeCountryCode('BR')).toBe('BR');
    expect(normalizeCountryCode('Us')).toBe('US');
  });

  it('returns null for absent or malformed values (single choke point)', () => {
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode(undefined)).toBeNull();
    expect(normalizeCountryCode('')).toBeNull();
    expect(normalizeCountryCode('BRA')).toBeNull();
    expect(normalizeCountryCode('B1')).toBeNull();
    expect(normalizeCountryCode(42)).toBeNull();
    expect(normalizeCountryCode({})).toBeNull();
  });
});

describe('flagImageUrl', () => {
  it('builds the flagcdn w20 URL, lowercased', () => {
    expect(flagImageUrl('BR')).toBe('https://flagcdn.com/w20/br.png');
    expect(flagImageUrl('us')).toBe('https://flagcdn.com/w20/us.png');
  });

  it('accepts a width step for retina srcSets', () => {
    expect(flagImageUrl('BR', 40)).toBe('https://flagcdn.com/w40/br.png');
  });
});

describe('countryDisplayName', () => {
  it('names the country in the UI locale (tooltip source, no articles)', () => {
    expect(countryDisplayName('BR', 'en')).toBe('Brazil');
    expect(countryDisplayName('BR', 'pt')).toBe('Brasil');
  });

  it('uppercases before lookup', () => {
    expect(countryDisplayName('br', 'en')).toBe('Brazil');
  });

  it('returns null for absent or malformed codes (flagless row)', () => {
    expect(countryDisplayName(null, 'en')).toBeNull();
    expect(countryDisplayName(undefined, 'en')).toBeNull();
    expect(countryDisplayName('', 'en')).toBeNull();
    expect(countryDisplayName('BRA', 'en')).toBeNull();
  });

  it('returns null for unknown regions and bad locales (RangeError-safe)', () => {
    expect(countryDisplayName('XX', 'en')).toBeNull();
    expect(countryDisplayName('BR', 'xx-invalid-!!')).toBeNull();
  });
});

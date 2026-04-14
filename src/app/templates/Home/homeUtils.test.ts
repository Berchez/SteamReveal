import { getLocationDetails, sortCitiesByScore } from './homeUtils';

describe('getLocationDetails (Unit Tests)', () => {
  it('should return full location details for a valid triple (US/AK/59)', async () => {
    const result = await getLocationDetails('US', 'AK', '59');

    expect(result.country).toEqual({ code: 'US', name: 'United States' });
    expect(result.state).toEqual({ code: 'AK', name: 'Alaska' });
    expect(result.city).toEqual({ id: 59, name: 'Anchorage' });
  });

  it('should be case-insensitive for countryCode', async () => {
    const result = await getLocationDetails('us', 'AK', '59');
    expect(result.country?.code).toBe('US');
    expect(result.country?.name).toBe('United States');
  });

  it('should return only country and state when cityID is missing', async () => {
    const result = await getLocationDetails('US', 'AK');

    expect(result.country?.name).toBe('United States');
    expect(result.state?.name).toBe('Alaska');
    expect(result.city).toBeUndefined();
  });

  it('should return only country when stateCode and cityID are missing', async () => {
    const result = await getLocationDetails('US');

    expect(result.country?.name).toBe('United States');
    expect(result.state).toBeUndefined();
    expect(result.city).toBeUndefined();
  });

  it('should return undefined fields for a non-existent country code', async () => {
    const result = await getLocationDetails('ZZ');

    expect(result.country).toBeUndefined();
    expect(result.state).toBeUndefined();
    expect(result.city).toBeUndefined();
  });

  it('should return undefined for state and city if stateCode is invalid', async () => {
    const result = await getLocationDetails('US', 'INVALID_STATE');

    expect(result.country?.name).toBe('United States');
    expect(result.state).toBeUndefined();
    expect(result.city).toBeUndefined();
  });

  it('should return undefined for city if cityID is invalid', async () => {
    const result = await getLocationDetails('US', 'AK', '999999');

    expect(result.country?.name).toBe('United States');
    expect(result.state?.name).toBe('Alaska');
    expect(result.city).toBeUndefined();
  });

  it('should return empty results if countryCode is not provided', async () => {
    const result = await getLocationDetails(undefined);

    expect(result.country).toBeUndefined();
    expect(result.state).toBeUndefined();
    expect(result.city).toBeUndefined();
  });
});

describe('sortCitiesByScore (Unit Tests)', () => {
  it('should sort cities by their score in descending order', () => {
    const input = {
      'US/AK/59': 10,
      'BR/SP/1': 100,
      'PT/01/5': 50,
    };

    const result = sortCitiesByScore(input);
    const keys = Object.keys(result);

    expect(keys).toEqual(['BR/SP/1', 'PT/01/5', 'US/AK/59']);
    expect(result['BR/SP/1']).toBe(100);
    expect(result['US/AK/59']).toBe(10);
  });

  it('should handle an empty object', () => {
    const result = sortCitiesByScore({});
    expect(result).toEqual({});
  });
});

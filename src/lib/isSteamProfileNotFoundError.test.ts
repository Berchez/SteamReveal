import isSteamProfileNotFoundError from './isSteamProfileNotFoundError';

describe('isSteamProfileNotFoundError (missing profile vs incident)', () => {
  it('matches the lib\'s exact thrown shape', () => {
    expect(isSteamProfileNotFoundError(new Error('No players found'))).toBe(
      true,
    );
  });

  it('never throws on non-Error garbage', () => {
    for (const value of [undefined, null, 42, 'No players found', {}]) {
      expect(() => isSteamProfileNotFoundError(value)).not.toThrow();
      expect(isSteamProfileNotFoundError(value)).toBe(false);
    }
  });

  it('keeps genuine failures out of the 400 bucket', () => {
    expect(isSteamProfileNotFoundError(new Error('socket hang up'))).toBe(
      false,
    );
    expect(isSteamProfileNotFoundError(new Error('Bad Request'))).toBe(false);
    expect(isSteamProfileNotFoundError(new Error('Unauthorized'))).toBe(
      false,
    );
  });
});

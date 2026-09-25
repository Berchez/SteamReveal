import isBenignOwnedGamesError, {
  isPrivateLibraryShapeError,
} from './isBenignOwnedGamesError';

describe('isPrivateLibraryShapeError (unambiguous lib-bug subset)', () => {
  it('matches ONLY the quoted-map TypeError in both V8 phrasings', () => {
    expect(
      isPrivateLibraryShapeError(
        new TypeError("Cannot read properties of undefined (reading 'map')"),
      ),
    ).toBe(true);
    expect(
      isPrivateLibraryShapeError(
        new TypeError("Cannot read property 'map' of undefined"),
      ),
    ).toBe(true);
  });

  it('rejects everything a dead key can produce (the whole point: unmaskable by key outage)', () => {
    // A revoked key yields these same strings via HTTP 401/403/400 — if
    // any of them passed here, gameLibraryStatsMethod could hide a key
    // outage behind warn-level logs.
    for (const message of [
      'Unauthorized',
      'Forbidden',
      'Bad Request',
      'No players found',
    ]) {
      expect(isPrivateLibraryShapeError(new Error(message))).toBe(false);
    }
    expect(
      isPrivateLibraryShapeError(new TypeError('e.map is not a function')),
    ).toBe(false);
    expect(isPrivateLibraryShapeError(new Error('socket hang up'))).toBe(
      false,
    );
    expect(isPrivateLibraryShapeError(undefined)).toBe(false);
  });
});

describe('isBenignOwnedGamesError (data-unavailability vs incident)', () => {
  it('classifies every privacy/data shape the Steam API answers with', () => {
    expect(isBenignOwnedGamesError(new Error('Unauthorized'))).toBe(true);
    expect(isBenignOwnedGamesError(new Error('Forbidden'))).toBe(true);
    expect(isBenignOwnedGamesError(new Error('Bad Request'))).toBe(true);
    expect(isBenignOwnedGamesError(new Error('No players found'))).toBe(true);
  });

  it('classifies steamapi\'s private/empty-library TypeError in both V8 phrasings', () => {
    // Modern V8 (Node 16.9+):
    expect(
      isBenignOwnedGamesError(
        new TypeError("Cannot read properties of undefined (reading 'map')"),
      ),
    ).toBe(true);
    // Older V8:
    expect(
      isBenignOwnedGamesError(
        new TypeError("Cannot read property 'map' of undefined"),
      ),
    ).toBe(true);
  });

  it('keeps real incidents out of the benign bucket', () => {
    expect(isBenignOwnedGamesError(new Error('socket hang up'))).toBe(false);
    expect(isBenignOwnedGamesError(new Error('timeout of 2500ms exceeded'))).toBe(
      false,
    );
    expect(isBenignOwnedGamesError(new Error('429 Too Many Requests'))).toBe(
      false,
    );
    // A TypeError that isn't the known lib-shape bug is OUR bug:
    expect(
      isBenignOwnedGamesError(new TypeError('cannot read config')),
    ).toBe(false);
  });

  it('keeps an UNQUOTED "x.map is not a function" loud (our bug, not the lib shape)', () => {
    // The entire quoted-vs-unquoted distinction, pinned literally: the
    // steamapi bug always cites 'map' in quotes ("reading 'map'" /
    // "property 'map'"); a bare "e.map is not a function" means some code
    // of ours called .map on a non-array and must stay an incident.
    expect(
      isBenignOwnedGamesError(new TypeError('e.map is not a function')),
    ).toBe(false);
    expect(
      isBenignOwnedGamesError(new TypeError("x.map is not a function")),
    ).toBe(false);
  });

  it('never throws on non-Error garbage', () => {
    for (const value of [undefined, null, 42, 'nope', {}]) {
      expect(() => isBenignOwnedGamesError(value)).not.toThrow();
      expect(isBenignOwnedGamesError(value)).toBe(false);
    }
  });
});

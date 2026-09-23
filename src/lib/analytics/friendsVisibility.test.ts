import { normalizeFriendsVisibility } from './friendsVisibility';

describe('normalizeFriendsVisibility', () => {
  it('passes the three known values through', () => {
    expect(normalizeFriendsVisibility('public')).toBe('public');
    expect(normalizeFriendsVisibility('private')).toBe('private');
    expect(normalizeFriendsVisibility('empty')).toBe('empty');
  });

  it('degrades anything else to null instead of a mislabeled bucket', () => {
    expect(normalizeFriendsVisibility('bogus')).toBeNull();
    expect(normalizeFriendsVisibility('')).toBeNull();
    expect(normalizeFriendsVisibility(undefined)).toBeNull();
    expect(normalizeFriendsVisibility(null)).toBeNull();
    expect(normalizeFriendsVisibility(42)).toBeNull();
    expect(normalizeFriendsVisibility({})).toBeNull();
  });
});

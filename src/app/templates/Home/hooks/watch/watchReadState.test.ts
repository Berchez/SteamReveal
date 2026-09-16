import {
  getLastSeenSearchedAt,
  latestSearchedAt,
  setLastSeenSearchedAt,
  WATCH_SEEN_KEY_PREFIX,
} from './watchReadState';

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const SEARCHED_OLD = '2026-06-01T00:00:00.000Z';
const SEARCHED_NEW = '2026-06-02T00:00:00.000Z';

describe('watchReadState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns null before anything was opened', () => {
    expect(getLastSeenSearchedAt(STEAM_A)).toBeNull();
  });

  it('round-trips the watermark', () => {
    setLastSeenSearchedAt(STEAM_A, SEARCHED_OLD);
    expect(getLastSeenSearchedAt(STEAM_A)).toBe(SEARCHED_OLD);
    setLastSeenSearchedAt(STEAM_A, SEARCHED_NEW);
    expect(getLastSeenSearchedAt(STEAM_A)).toBe(SEARCHED_NEW);
  });

  it('namespaces watermarks per steamId (no cross-profile leaks)', () => {
    setLastSeenSearchedAt(STEAM_A, SEARCHED_NEW);

    expect(getLastSeenSearchedAt(STEAM_A)).toBe(SEARCHED_NEW);
    expect(getLastSeenSearchedAt(STEAM_B)).toBeNull();
    expect(
      window.localStorage.getItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`),
    ).toBe(SEARCHED_NEW);
  });

  it('ignores invalid steamIds and timestamps without throwing', () => {
    expect(getLastSeenSearchedAt('nope')).toBeNull();
    expect(() => setLastSeenSearchedAt('nope', SEARCHED_NEW)).not.toThrow();
    expect(() => setLastSeenSearchedAt(STEAM_A, 'garbage')).not.toThrow();
    expect(() => setLastSeenSearchedAt(STEAM_A, '')).not.toThrow();

    expect(getLastSeenSearchedAt(STEAM_A)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('clears the watermark on null (corrupt-cursor recovery)', () => {
    setLastSeenSearchedAt(STEAM_A, SEARCHED_NEW);
    expect(getLastSeenSearchedAt(STEAM_A)).toBe(SEARCHED_NEW);

    setLastSeenSearchedAt(STEAM_A, null);
    expect(getLastSeenSearchedAt(STEAM_A)).toBeNull();
    expect(
      window.localStorage.getItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`),
    ).toBeNull();
  });

  it('treats garbage stored values as never-opened', () => {
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      'garbage',
    );
    expect(getLastSeenSearchedAt(STEAM_A)).toBeNull();

    window.localStorage.setItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`, '12345');
    expect(getLastSeenSearchedAt(STEAM_A)).toBeNull();
  });

  it('persists across reloads (localStorage survival)', () => {
    // Same contract the inbox relies on: a reload keeps the watermark, so
    // already-opened notifications do not resurrect as unread.
    setLastSeenSearchedAt(STEAM_A, SEARCHED_NEW);
    expect(getLastSeenSearchedAt(STEAM_A)).toBe(SEARCHED_NEW);
  });

  it('keeps a pre-split delivery watermark as a valid search cursor', () => {
    // Upgrade path: values stored by the old sent_at era are full ISO
    // timestamps, so they still parse and compare as searched_at cursors.
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      SEARCHED_NEW,
    );
    expect(getLastSeenSearchedAt(STEAM_A)).toBe(SEARCHED_NEW);
  });
});

describe('latestSearchedAt', () => {
  it('returns the max finite-date searchedAt regardless of position', () => {
    expect(
      latestSearchedAt([
        { searchedAt: SEARCHED_OLD },
        { searchedAt: SEARCHED_NEW },
      ]),
    ).toBe(SEARCHED_NEW);
    expect(
      latestSearchedAt([
        { searchedAt: SEARCHED_NEW },
        { searchedAt: SEARCHED_OLD },
      ]),
    ).toBe(SEARCHED_NEW);
    expect(latestSearchedAt([])).toBeNull();
  });

  it('skips corrupt timestamps instead of watermarking garbage', () => {
    expect(
      latestSearchedAt([{ searchedAt: 'garbage' }, { searchedAt: SEARCHED_OLD }]),
    ).toBe(SEARCHED_OLD);
    expect(latestSearchedAt([{ searchedAt: 'garbage' }])).toBeNull();
  });
});

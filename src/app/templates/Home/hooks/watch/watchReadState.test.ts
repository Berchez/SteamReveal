import {
  getLastSeenSentAt,
  latestSentAt,
  setLastSeenSentAt,
  WATCH_SEEN_KEY_PREFIX,
} from './watchReadState';

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const SENT_OLD = '2026-06-01T00:00:00.000Z';
const SENT_NEW = '2026-06-02T00:00:00.000Z';

describe('watchReadState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns null before anything was opened', () => {
    expect(getLastSeenSentAt(STEAM_A)).toBeNull();
  });

  it('round-trips the watermark', () => {
    setLastSeenSentAt(STEAM_A, SENT_OLD);
    expect(getLastSeenSentAt(STEAM_A)).toBe(SENT_OLD);
    setLastSeenSentAt(STEAM_A, SENT_NEW);
    expect(getLastSeenSentAt(STEAM_A)).toBe(SENT_NEW);
  });

  it('namespaces watermarks per steamId (no cross-profile leaks)', () => {
    setLastSeenSentAt(STEAM_A, SENT_NEW);

    expect(getLastSeenSentAt(STEAM_A)).toBe(SENT_NEW);
    expect(getLastSeenSentAt(STEAM_B)).toBeNull();
    expect(
      window.localStorage.getItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`),
    ).toBe(SENT_NEW);
  });

  it('ignores invalid steamIds and timestamps without throwing', () => {
    expect(getLastSeenSentAt('nope')).toBeNull();
    expect(() => setLastSeenSentAt('nope', SENT_NEW)).not.toThrow();
    expect(() => setLastSeenSentAt(STEAM_A, 'garbage')).not.toThrow();
    expect(() => setLastSeenSentAt(STEAM_A, '')).not.toThrow();

    expect(getLastSeenSentAt(STEAM_A)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('treats garbage stored values as never-opened', () => {
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      'garbage',
    );
    expect(getLastSeenSentAt(STEAM_A)).toBeNull();

    window.localStorage.setItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`, '12345');
    expect(getLastSeenSentAt(STEAM_A)).toBeNull();
  });

  it('persists across reloads (localStorage survival)', () => {
    // Same contract the inbox relies on: a reload keeps the watermark, so
    // already-opened notifications do not resurrect as unread.
    setLastSeenSentAt(STEAM_A, SENT_NEW);
    expect(getLastSeenSentAt(STEAM_A)).toBe(SENT_NEW);
  });
});

describe('latestSentAt', () => {
  it('returns the max finite-date sentAt regardless of position', () => {
    expect(latestSentAt([{ sentAt: SENT_OLD }, { sentAt: SENT_NEW }])).toBe(
      SENT_NEW,
    );
    expect(latestSentAt([{ sentAt: SENT_NEW }, { sentAt: SENT_OLD }])).toBe(
      SENT_NEW,
    );
    expect(latestSentAt([])).toBeNull();
  });

  it('skips corrupt timestamps instead of watermarking garbage', () => {
    expect(latestSentAt([{ sentAt: 'garbage' }, { sentAt: SENT_OLD }])).toBe(
      SENT_OLD,
    );
    expect(latestSentAt([{ sentAt: 'garbage' }])).toBeNull();
  });
});

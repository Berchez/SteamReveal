import { isValidCloseFriendItem } from './index';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';

describe('MAX_CLOSE_FRIENDS', () => {
  it('matches the real cap GET /api/getCloseFriends uses (twentyClosestFriends)', () => {
    // If this ever fails because someone changed one side and not the
    // other, that's exactly the drift this constant exists to prevent —
    // update BOTH getCloseFriends/route.ts's slice(0, N) and this value
    // together (see the doc comment on MAX_CLOSE_FRIENDS).
    expect(MAX_CLOSE_FRIENDS).toBe(20);
  });
});

describe('isValidCloseFriendItem', () => {
  it('accepts a well-formed item', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: 5,
      }),
    ).toBe(true);
  });

  it('accepts extra UserSummary fields without over-validating them', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523', nickname: 'Alice', avatar: {} },
        count: 0,
        probability: 42,
      }),
    ).toBe(true);
  });

  it('accepts count === 0 (not falsy-rejected)', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: 0,
      }),
    ).toBe(true);
  });

  it.each([
    ['a bare string', '76561198146931523'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 123],
  ])('rejects a non-object item (%s)', (_label, value) => {
    expect(isValidCloseFriendItem(value)).toBe(false);
  });

  it('rejects a missing friend field', () => {
    expect(isValidCloseFriendItem({ count: 5 })).toBe(false);
  });

  // getCloseFriends/route.ts can legitimately produce `friend: null` for
  // an unresolvable/private Steam summary (`friend: summary || null`),
  // even though closeFriendsDataIWant's type says `friend: UserSummary`
  // (non-nullable) — a pre-existing type/runtime mismatch found while
  // investigating Ticket 8. This item should be filtered out, not crash
  // anything downstream.
  it('rejects a null friend (real getCloseFriends null-summary edge case)', () => {
    expect(isValidCloseFriendItem({ friend: null, count: 5 })).toBe(false);
  });

  it('rejects a non-string steamID', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: 76561198146931523 },
        count: 5,
      }),
    ).toBe(false);
  });

  it('rejects a steamID that is too short to be a real Steam64 id', () => {
    expect(
      isValidCloseFriendItem({ friend: { steamID: '123' }, count: 5 }),
    ).toBe(false);
  });

  it('rejects a steamID with non-digit characters', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '7656119814693152x' },
        count: 5,
      }),
    ).toBe(false);
  });

  it('rejects a steamID that is an oversized string (per-field DoS, not just array-length)', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '1'.repeat(100000) },
        count: 5,
      }),
    ).toBe(false);
  });

  it('rejects a missing count', () => {
    expect(
      isValidCloseFriendItem({ friend: { steamID: '76561198146931523' } }),
    ).toBe(false);
  });

  it('rejects NaN count', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: NaN,
      }),
    ).toBe(false);
  });

  // calcBansWeight() uses count as an exponent multiplier
  // (3 ** (... * closeFriendCount)); Infinity there produces a value
  // JSON.stringify silently turns into `null` on the way to the model.
  it('rejects Infinity count', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: Infinity,
      }),
    ).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: -1,
      }),
    ).toBe(false);
  });

  it('rejects a string count', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: '5',
      }),
    ).toBe(false);
  });

  // Regression test for the real bug found while reviewing bannedFriendsMethod:
  // a single well-formed item with a huge (but finite, non-negative) count
  // was previously accepted and would blow up calcBansWeight's
  // 3 ** (bansSum * count) to Infinity — without needing an oversized
  // array or a malformed steamID at all.
  it('accepts count at the MAX_FRIEND_COUNT boundary (120)', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: 120,
      }),
    ).toBe(true);
  });

  it('accepts count at 100 (the real structural max: friendsOfTheTarget is capped at 100 in getCloseFriends)', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: 100,
      }),
    ).toBe(true);
  });

  it('rejects a count above MAX_FRIEND_COUNT even though it is finite and non-negative', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: 121,
      }),
    ).toBe(false);
  });

  it('rejects an absurdly large finite count that would overflow 3 ** (bansSum * count) to Infinity', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523' },
        count: 1_000_000,
      }),
    ).toBe(false);
  });

  it('rejects an oversized nickname (response-payload bloat)', () => {
    expect(
      isValidCloseFriendItem({
        friend: {
          steamID: '76561198146931523',
          nickname: 'x'.repeat(1000),
        },
        count: 5,
      }),
    ).toBe(false);
  });

  it('rejects a non-string nickname when present', () => {
    expect(
      isValidCloseFriendItem({
        friend: { steamID: '76561198146931523', nickname: 12345 },
        count: 5,
      }),
    ).toBe(false);
  });
});

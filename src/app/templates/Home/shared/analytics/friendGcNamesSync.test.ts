/**
 * @jest-environment jsdom
 */
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import axios from 'axios';
import {
  collectFriendGcNames,
  postFriendGcNames,
  scheduleSyncAttempts,
} from './friendGcNamesSync';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeFriend = (steamID: string): closeFriendsDataIWant => ({
  friend: { steamID } as unknown as closeFriendsDataIWant['friend'],
  count: 1,
  probability: 50,
});

const registry = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe('collectFriendGcNames', () => {
  it('returns [] for an empty/undefined friend list', () => {
    const reg = registry({ '76561198000000000': 'Alice' });
    expect(collectFriendGcNames(undefined, reg)).toEqual([]);
    expect(collectFriendGcNames([], reg)).toEqual([]);
  });

  it('intersects friends with the registry and emits only confirmed names', () => {
    const friends = [
      makeFriend('76561198000000001'),
      makeFriend('76561198000000002'),
      makeFriend('76561198000000003'),
    ];
    const reg = registry({
      '76561198000000001': 'Alice',
      // Friend 2 has nothing in the registry -> excluded.
      '76561198000000003': 'Carol',
      '76561198000000099': 'NotAFriend', // not in the friend list -> excluded
    });

    expect(collectFriendGcNames(friends, reg)).toEqual([
      { steamId: '76561198000000001', gcName: 'Alice' },
      { steamId: '76561198000000003', gcName: 'Carol' },
    ]);
  });

  it('dedupes repeated steamIds in the friend list', () => {
    const friends = [
      makeFriend('76561198000000001'),
      makeFriend('76561198000000001'),
    ];
    const reg = registry({ '76561198000000001': 'Alice' });

    expect(collectFriendGcNames(friends, reg)).toHaveLength(1);
  });

  it('honors the exclude set (already-sent ids)', () => {
    const friends = [
      makeFriend('76561198000000001'),
      makeFriend('76561198000000002'),
    ];
    const reg = registry({
      '76561198000000001': 'Alice',
      '76561198000000002': 'Bob',
    });
    const exclude = new Set(['76561198000000001']);

    expect(collectFriendGcNames(friends, reg, exclude)).toEqual([
      { steamId: '76561198000000002', gcName: 'Bob' },
    ]);
  });

  it('skips friends without a steamId', () => {
    const noId = {
      friend: { steamID: undefined },
      count: 1,
    } as unknown as closeFriendsDataIWant;
    const reg = registry({ '76561198000000001': 'Alice' });

    expect(collectFriendGcNames([noId], reg)).toEqual([]);
  });
});

describe('postFriendGcNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.setItem('analytics_skip_password', 'secret');
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('posts the payload with the skip headers and resolves true on ok', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { ok: true, updated: 2 } });

    const ok = await postFriendGcNames('search-1', [
      { steamId: '76561198000000001', gcName: 'Alice' },
    ]);

    expect(ok).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/recordAnalyticsFriends',
      {
        searchId: 'search-1',
        gcNames: [{ steamId: '76561198000000001', gcName: 'Alice' }],
      },
      { headers: { 'x-analytics-skip-password': 'secret' } },
    );
  });

  it('resolves false when the route does not acknowledge the write', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { ok: false } });

    const ok = await postFriendGcNames('search-1', [
      { steamId: '76561198000000001', gcName: 'Alice' },
    ]);

    expect(ok).toBe(false);
  });

  it('resolves false (never throws) on a network failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('network down'));

    const ok = await postFriendGcNames('search-1', [
      { steamId: '76561198000000001', gcName: 'Alice' },
    ]);

    expect(ok).toBe(false);
  });

  it('skips the request entirely for empty entries/missing searchId', async () => {
    expect(await postFriendGcNames('', [])).toBe(false);
    expect(await postFriendGcNames('search-1', [])).toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('scheduleSyncAttempts', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires attempt once per delay', () => {
    jest.useFakeTimers();
    const attempt = jest.fn();

    const cancel = scheduleSyncAttempts([1000, 3000], attempt);

    jest.advanceTimersByTime(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2000);
    expect(attempt).toHaveBeenCalledTimes(2);
    cancel();
  });

  it('cancel prevents any further attempt', () => {
    jest.useFakeTimers();
    const attempt = jest.fn();

    const cancel = scheduleSyncAttempts([1000, 3000], attempt);
    cancel();

    jest.advanceTimersByTime(10_000);
    expect(attempt).not.toHaveBeenCalled();
  });
});

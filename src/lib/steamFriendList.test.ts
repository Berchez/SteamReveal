/**
 * @jest-environment node
 */
import { isBotFriend } from './steamFriendList';

const BOT = '76561199000000001';
const USER = '76561198000000001';
const OTHER = '76561198000000002';

const friendsResponse = (friends: unknown) => ({
  ok: true,
  json: async () => ({ response: { friendslist: { friends } } }),
});

const friendEntry = (steamid: string) => ({
  steamid,
  relationship: 'friend',
  friend_since: 1700000000,
});

const fetchMock = () => {
  const mock = jest.fn(async () => friendsResponse([]));
  global.fetch = mock as unknown as typeof fetch;
  return mock as jest.Mock;
};

describe('isBotFriend', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('returns true when the user is on the bot friend list', async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(
      friendsResponse([friendEntry(OTHER), friendEntry(USER)]),
    );

    await expect(isBotFriend('fake-key', BOT, USER)).resolves.toBe(true);
    const [url] = mock.mock.calls[0] as unknown as [string];
    expect(url).toContain('GetFriendList');
    expect(url).toContain(`steamid=${BOT}`);
    expect(url).toContain('relationship=friend');
    expect(url).toContain('key=fake-key');
  });

  it('returns false when the user is absent (or the list is empty)', async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(friendsResponse([friendEntry(OTHER)]));
    await expect(isBotFriend('fake-key', BOT, USER)).resolves.toBe(false);

    mock.mockResolvedValue(friendsResponse([]));
    await expect(isBotFriend('fake-key', BOT, USER)).resolves.toBe(false);
  });

  it('returns null for bad ids, missing keys, and non-ok responses (unknown, never throws)', async () => {
    const mock = fetchMock();

    await expect(isBotFriend('fake-key', 'short', USER)).resolves.toBeNull();
    await expect(isBotFriend('fake-key', BOT, 'short')).resolves.toBeNull();
    await expect(isBotFriend('', BOT, USER)).resolves.toBeNull();
    expect(mock).not.toHaveBeenCalled();

    // Private bot list / bad key read as unknown (fail-closed upstream),
    // never as "not friends".
    mock.mockResolvedValue({ ok: false, status: 401 });
    await expect(isBotFriend('fake-key', BOT, USER)).resolves.toBeNull();

    mock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(isBotFriend('fake-key', BOT, USER)).resolves.toBeNull();
  });

  it('returns null when fetch throws (never rejects)', async () => {
    const mock = jest.fn(async () => {
      throw new Error('Steam down');
    });
    global.fetch = mock as unknown as typeof fetch;

    await expect(isBotFriend('fake-key', BOT, USER)).resolves.toBeNull();
  });
});

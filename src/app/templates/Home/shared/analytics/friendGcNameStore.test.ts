import {
  clearFriendGcNames,
  getFriendGcName,
  getFriendGcNameRegistry,
  setFriendGcName,
} from './friendGcNameStore';

describe('friendGcNameStore', () => {
  beforeEach(() => {
    clearFriendGcNames();
  });

  it('stores and retrieves a confirmed name', () => {
    setFriendGcName('76561198000000000', 'João Teste');
    expect(getFriendGcName('76561198000000000')).toBe('João Teste');
  });

  it('never stores a null/empty name (a miss must stay a miss)', () => {
    setFriendGcName('76561198000000000', '');
    setFriendGcName('76561198000000001', null as unknown as string);
    expect(getFriendGcName('76561198000000000')).toBeUndefined();
    expect(getFriendGcName('76561198000000001')).toBeUndefined();
  });

  it('ignores a missing steamId', () => {
    setFriendGcName('', 'Name');
    expect(getFriendGcNameRegistry().size).toBe(0);
  });

  it('overwrites a previous name for the same steamId', () => {
    setFriendGcName('76561198000000000', 'Old');
    setFriendGcName('76561198000000000', 'New');
    expect(getFriendGcName('76561198000000000')).toBe('New');
    expect(getFriendGcNameRegistry().size).toBe(1);
  });

  it('snapshot is a copy — mutating it does not touch the store', () => {
    setFriendGcName('76561198000000000', 'Name');
    const snapshot = getFriendGcNameRegistry();
    (snapshot as Map<string, string>).clear();
    expect(getFriendGcName('76561198000000000')).toBe('Name');
  });

  it('clear empties the registry', () => {
    setFriendGcName('76561198000000000', 'Name');
    clearFriendGcNames();
    expect(getFriendGcName('76561198000000000')).toBeUndefined();
    expect(getFriendGcNameRegistry().size).toBe(0);
  });
});

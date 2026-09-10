import {
  WATCH_IDENTITY_EVENT,
  WATCH_IDENTITY_KEY,
  isValidWatchIdentity,
  getWatchIdentity,
  notifyWatchIdentityChanged,
  setWatchIdentity,
  clearWatchIdentity,
} from './watchIdentity';

const STEAM_ID = '76561198000000001';

describe('watchIdentity', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('saves, recovers and removes the SteamID', () => {
    expect(setWatchIdentity(STEAM_ID)).toBe(true);
    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBe(STEAM_ID);
    expect(getWatchIdentity()).toBe(STEAM_ID);

    clearWatchIdentity();
    expect(getWatchIdentity()).toBeNull();
    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBeNull();
  });

  it('returns null when nothing was ever stored', () => {
    expect(getWatchIdentity()).toBeNull();
  });

  it('refuses to store invalid ids (and stores nothing)', () => {
    for (const bad of [
      '',
      'short',
      123 as unknown as string,
      null,
      undefined,
    ]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(setWatchIdentity(bad as any)).toBe(false);
    }

    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBeNull();
    expect(getWatchIdentity()).toBeNull();
  });

  it('treats garbage already in storage as absent', () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, 'not-an-id');

    expect(getWatchIdentity()).toBeNull();
  });

  it('survives a hostile localStorage (throws on access)', () => {
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('private mode');
        },
        setItem: () => {
          throw new Error('private mode');
        },
        removeItem: () => {
          throw new Error('private mode');
        },
      },
    });
    try {
      expect(getWatchIdentity()).toBeNull();
      expect(setWatchIdentity(STEAM_ID)).toBe(false);
      expect(() => clearWatchIdentity()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it('behaves on the server, where window does not exist', () => {
    const realWindow = globalThis.window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
    try {
      expect(getWatchIdentity()).toBeNull();
      expect(setWatchIdentity(STEAM_ID)).toBe(false);
      expect(() => clearWatchIdentity()).not.toThrow();
    } finally {
      globalThis.window = realWindow;
    }
  });

  it('only ever persists the public SteamID (key + shape contract)', () => {
    setWatchIdentity(STEAM_ID);

    expect(WATCH_IDENTITY_KEY).toBe('steamreveal:watch:me');
    expect(isValidWatchIdentity(STEAM_ID)).toBe(true);
    expect(isValidWatchIdentity('')).toBe(false);
  });

  it('broadcasts same-tab identity changes without payload or throws', () => {
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push(event.type);
    };
    window.addEventListener(WATCH_IDENTITY_EVENT, listener);
    try {
      expect(() => notifyWatchIdentityChanged()).not.toThrow();
      expect(seen).toEqual([WATCH_IDENTITY_EVENT]);
    } finally {
      window.removeEventListener(WATCH_IDENTITY_EVENT, listener);
    }
  });

  it('broadcast is a no-op on the server', () => {
    const realWindow = globalThis.window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
    try {
      expect(() => notifyWatchIdentityChanged()).not.toThrow();
    } finally {
      globalThis.window = realWindow;
    }
  });
});

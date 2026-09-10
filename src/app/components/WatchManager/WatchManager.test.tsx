import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchManager from './WatchManager';
import {
  WATCH_IDENTITY_EVENT,
  WATCH_IDENTITY_KEY,
} from '@/app/templates/Home/hooks/watch/watchIdentity';

jest.mock('react-toastify', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

// Stable reference (same reason as useWatchStatus.test.ts): the hook keys
// its effect on the translator identity.
const mockTranslate = (key: string) => key;

jest.mock('next-intl', () => ({
  useLocale: () => 'pt',
  useTranslations: () => mockTranslate,
}));

const STEAM_ID = '76561198000000001';

const postOk = () =>
  ({
    ok: true,
    json: async () => ({
      steamId: STEAM_ID,
      status: 'pending',
      inviteQueued: true,
      pendingExpiresInMs: null,
    }),
  }) as Response;

const statusResponse = (status: string) =>
  ({
    ok: true,
    json: async () => ({ steamId: STEAM_ID, status }),
  }) as Response;

describe('WatchManager', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  const settle = async () => {
    await act(async () => {});
  };

  it('renders the registration form when nothing is watched', async () => {
    render(<WatchManager />);
    await settle();

    expect(screen.getByText('watchTitle')).toBeInTheDocument();
    expect(screen.getByText('watchDescription')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('watchInputPlaceholder'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid id locally without posting', async () => {
    render(<WatchManager />);
    await settle();

    fireEvent.change(screen.getByPlaceholderText('watchInputPlaceholder'), {
      target: { value: 'nope' },
    });
    fireEvent.click(screen.getByText('watchSubmit'));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('watchErrorInvalid')).toBeInTheDocument();
  });

  it('submits a valid id, persists identity, and shows pending instructions', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/watch/request')) return postOk();
      return statusResponse('pending');
    });

    render(<WatchManager />);
    await settle();

    fireEvent.change(screen.getByPlaceholderText('watchInputPlaceholder'), {
      target: { value: STEAM_ID },
    });
    fireEvent.click(screen.getByText('watchSubmit'));
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/watch/request',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ steamId: STEAM_ID, locale: 'pt' }),
      }),
    );
    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBe(STEAM_ID);
    expect(screen.getByText('watchPendingTitle')).toBeInTheDocument();
    expect(screen.getByText('watchPendingHint')).toBeInTheDocument();
  });

  it('broadcasts identity changes so same-tab siblings resync without reload', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/watch/request')) return postOk();
      return statusResponse('pending');
    });
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push(event.type);
    };
    window.addEventListener(WATCH_IDENTITY_EVENT, listener);
    try {
      render(<WatchManager />);
      await settle();

      // Successful submit: stored + broadcast (WatchInbox listens).
      fireEvent.change(screen.getByPlaceholderText('watchInputPlaceholder'), {
        target: { value: STEAM_ID },
      });
      fireEvent.click(screen.getByText('watchSubmit'));
      await settle();
      expect(seen).toEqual([WATCH_IDENTITY_EVENT]);
    } finally {
      window.removeEventListener(WATCH_IDENTITY_EVENT, listener);
    }
  });

  it('skips the broadcast when storage refuses the write (no phantom ping)', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/watch/request')) return postOk();
      return statusResponse('pending');
    });
    // Direct `window.localStorage.setItem = ...` assignment does not stick
    // in this jsdom (same reason the watchIdentity hostile test replaces
    // the whole property): swap the property, restore afterwards.
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('private mode');
        },
        removeItem: () => {},
        clear: () => {},
        get length() {
          return 0;
        },
        key: () => null,
      },
    });
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push(event.type);
    };
    window.addEventListener(WATCH_IDENTITY_EVENT, listener);
    try {
      render(<WatchManager />);
      await settle();

      fireEvent.change(screen.getByPlaceholderText('watchInputPlaceholder'), {
        target: { value: STEAM_ID },
      });
      fireEvent.click(screen.getByText('watchSubmit'));
      await settle();

      // Session still proceeds (polling reads React state, not storage),
      // but no sibling is pinged toward a slot that was never written.
      expect(seen).toEqual([]);
      expect(screen.getByText('watchPendingTitle')).toBeInTheDocument();
    } finally {
      window.removeEventListener(WATCH_IDENTITY_EVENT, listener);
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it('shows the leave instructions when active, and forgets on remove', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_ID);
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/watch/request')) return postOk();
      return statusResponse('active');
    });

    render(<WatchManager />);
    await settle();

    expect(screen.getByText('watchActiveTitle')).toBeInTheDocument();
    expect(screen.getByText('watchActiveHint')).toBeInTheDocument();

    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push(event.type);
    };
    window.addEventListener(WATCH_IDENTITY_EVENT, listener);
    try {
      fireEvent.click(screen.getByText('watchRemoveLocal'));
      await settle();
    } finally {
      window.removeEventListener(WATCH_IDENTITY_EVENT, listener);
    }

    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBeNull();
    expect(seen).toEqual([WATCH_IDENTITY_EVENT]);
    expect(screen.getByText('watchTitle')).toBeInTheDocument();
  });

  it('shows an error when the request fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/watch/request')) {
        return { ok: false, status: 500 };
      }
      return statusResponse('pending');
    });

    render(<WatchManager />);
    await settle();

    fireEvent.change(screen.getByPlaceholderText('watchInputPlaceholder'), {
      target: { value: STEAM_ID },
    });
    fireEvent.click(screen.getByText('watchSubmit'));
    await settle();

    expect(screen.getByText('watchErrorFailed')).toBeInTheDocument();
    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBeNull();
  });

  it('heals a stale local identity (server says none) back to the form', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_ID);
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/watch/request')) return postOk();
      return statusResponse('none');
    });

    render(<WatchManager />);
    await settle();

    expect(window.localStorage.getItem(WATCH_IDENTITY_KEY)).toBeNull();
    expect(screen.getByText('watchTitle')).toBeInTheDocument();
  });
});

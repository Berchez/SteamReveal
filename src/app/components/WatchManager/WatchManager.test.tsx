import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchManager from './WatchManager';

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

const postOk = (overrides = {}) =>
  ({
    ok: true,
    json: async () => ({
      steamId: STEAM_ID,
      status: 'pending',
      inviteQueued: true,
      pendingExpiresInMs: null,
      ...overrides,
    }),
  }) as Response;

const statusResponse = (status: string) =>
  ({
    ok: true,
    json: async () => ({ steamId: STEAM_ID, status }),
  }) as Response;

const fetchByUrl = (impl: (url: string) => Promise<Response> | Response) => {
  const mock = jest.fn(async (input: unknown) => impl(String(input)));
  global.fetch = mock as unknown as typeof fetch;
  return mock;
};

describe('WatchManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const settle = async () => {
    await act(async () => {});
  };

  const flushPolls = async (count: number) => {
    // Same proven pattern as useWatchStatus.test.ts: one timer advance +
    // microtask flush per round. A single advance does NOT deterministically
    // complete the multi-hop poll chain (fetch → json → setState), which
    // flakes exactly like a real race — N rounds make it structural.
    for (let i = 0; i < count; i += 1) {
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {});
    }
  };

  it('mounts read-only: no request fires without an explicit click', async () => {
    const fetchMock = fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) return postOk();
      return statusResponse('pending');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(3);

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/watch/request'),
      ),
    ).toHaveLength(0);
    expect(screen.getByText('watchPendingTitle')).toBeInTheDocument();
  });

  it('starts watching on explicit click (locale only, never a typed id)', async () => {
    const fetchMock = fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) return postOk();
      return statusResponse('none');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    expect(screen.getByText('watchTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('watchSubmit'));
    await settle();

    const posted = fetchMock.mock.calls.find(([calledUrl]) =>
      String(calledUrl).includes('/api/watch/request'),
    ) as unknown as [string, RequestInit];
    expect(posted).toBeDefined();
    // Self-scoped: locale travels, identity never leaves the session.
    expect(JSON.parse(posted[1].body as string)).toEqual({ locale: 'pt' });
  });

  it('rides pending to active via polling', async () => {
    const statuses = ['pending', 'pending', 'active'];
    fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) return postOk();
      return statusResponse(statuses.shift() ?? 'active');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await settle();

    expect(screen.getByText('watchPendingTitle')).toBeInTheDocument();
    await flushPolls(3);
    expect(screen.getByText('watchActiveTitle')).toBeInTheDocument();
  });

  it('never re-subscribes after opt-out (status none stays a dead end)', async () => {
    // The P0 that motivated explicit creation: unfriend deletes the row
    // (reads as 'none'), and a mount must NOT recreate it by itself —
    // otherwise every /watch visit would undo the opt-out.
    const fetchMock = fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) return postOk();
      return statusResponse('none');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(4);

    expect(screen.getByText('watchTitle')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/watch/request'),
      ),
    ).toHaveLength(0);
  });

  it('shows a request error without blocking the status screens', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) {
        return { ok: false, status: 500 } as Response;
      }
      return statusResponse('none');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);

    fireEvent.click(screen.getByText('watchSubmit'));
    await settle();

    expect(screen.getByText('watchErrorFailed')).toBeInTheDocument();
    // Still on the not-watching screen (nothing was created server-side).
    expect(screen.getByText('watchTitle')).toBeInTheDocument();
  });

  it('shows the login gate when the session died mid-use', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) return postOk();
      return { ok: false, status: 401 } as Response;
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(2);

    const loginLink = screen.getByText('watchLoginButton');
    expect(loginLink.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/api/auth/steam/login'),
    );
  });

  it('shows a plain error for unexpected hook failures (never blank)', async () => {
    // Defensive branch: unreachable with server-verified ids, but a bug
    // must render visibly instead of a blank screen. 'invalid' id forces
    // the hook down it without any fetch.
    render(<WatchManager steamId={'nope'} />);
    await flushPolls(1);

    expect(screen.getByRole('alert')).toHaveTextContent('watchErrorFailed');
  });

  it('logs out and reloads into the login gate', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/watch/request')) return postOk();
      if (url.includes('/api/auth/logout')) {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return statusResponse('active');
    });
    const reload = jest.fn();
    const locationSpy = jest
      .spyOn(window, 'location', 'get')
      .mockReturnValue({ reload } as unknown as Location);

    render(<WatchManager steamId={STEAM_ID} />);
    // Same multi-round flush.
    await flushPolls(2);
    expect(screen.getByText('watchActiveTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('watchLogout'));
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    locationSpy.mockRestore();
  });
});

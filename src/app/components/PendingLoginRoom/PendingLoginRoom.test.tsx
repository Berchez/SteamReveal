import fs from 'fs';
import path from 'path';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import PendingLoginRoom from './PendingLoginRoom';

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    usePathname: () => '/player/player-c',
  }),
}));

const BOT_PROFILE = 'https://steamcommunity.com/profiles/76561199000000001';

const setLocation = (search: string) => {
  Object.defineProperty(window, 'location', {
    value: { href: `http://localhost/en/${search}`, search },
    writable: true,
    configurable: true,
  });
};

describe('PendingLoginRoom', () => {
  const replaceState = jest.fn();
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    window.history.replaceState = replaceState;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const flush = () =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

  it('renders only the no-JS fallback (and never polls) without ?login=waiting', async () => {
    setLocation('');
    const { container } = render(<PendingLoginRoom />);
    await flush();

    // Static SSR fallback only: the overlay (and its loop) never starts.
    const noscript = container.querySelector('noscript');
    expect(noscript).not.toBeNull();
    expect(noscript?.textContent).toContain('watchWaitNoScript');
    expect(screen.queryByText('watchWaitTitle')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the waiting room with the bot link from the first poll', async () => {
    setLocation('?login=waiting');
    fetchMock.mockResolvedValue({
      json: async () => ({ done: false, botProfileUrl: BOT_PROFILE }),
    });

    render(<PendingLoginRoom />);
    await flush();

    expect(screen.getByText('watchWaitTitle')).toBeInTheDocument();
    expect(screen.getByText('watchWaitBody')).toBeInTheDocument();
    expect(screen.getByText('watchWaitWaiting')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'watchWaitAddBot' }),
    ).toHaveAttribute('href', BOT_PROFILE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/steam/pending', {
      method: 'GET',
    });
  });

  it('keeps polling every 10s while waiting', async () => {
    setLocation('?login=waiting');
    fetchMock.mockResolvedValue({
      json: async () => ({ done: false, botProfileUrl: BOT_PROFILE }),
    });

    render(<PendingLoginRoom />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Still waiting, no navigation, no param strip.
    expect(screen.getByText('watchWaitWaiting')).toBeInTheDocument();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('navigates to the redirect the moment completion lands', async () => {
    setLocation('?login=waiting');
    fetchMock.mockResolvedValue({
      json: async () => ({
        done: true,
        redirect: 'http://localhost/en/?watch=new',
        botProfileUrl: BOT_PROFILE,
      }),
    });

    render(<PendingLoginRoom />);
    await flush();

    expect(window.location.href).toBe('http://localhost/en/?watch=new');
  });

  it('shows the expired screen (and strips the param) when the wait is over', async () => {
    setLocation('?login=waiting');
    fetchMock.mockResolvedValue({
      json: async () => ({ done: false, expired: true, botProfileUrl: null }),
    });

    render(<PendingLoginRoom />);
    await flush();

    expect(screen.getByText('watchWaitExpired')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'watchWaitRetry' }),
    ).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2Fplayer%2Fplayer-c',
    );
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('login');

    // Expired ends the loop: no further polls.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('references only keys that exist in the real locale files', () => {
    // Key-echo mocks render ANY key string, so a typo here (or a key
    // renamed in messages/) stays green at unit level and only explodes
    // in e2e/prod as raw "Watch.xxx" text. Pin the contract directly.
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'messages', 'en.json'),
      'utf8',
    );
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const watch = (JSON.parse(withoutBom) as { Watch: Record<string, unknown> })
      .Watch;
    for (const key of [
      'watchWaitTitle',
      'watchWaitBody',
      'watchWaitAddBot',
      'watchWaitWaiting',
      'watchWaitExpired',
      'watchWaitRetry',
    ]) {
      expect(typeof watch[key]).toBe('string');
    }
  });

  it('skips fetching while the tab is hidden and polls on return', async () => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    try {
      setLocation('?login=waiting');
      fetchMock.mockResolvedValue({
        json: async () => ({ done: false, botProfileUrl: BOT_PROFILE }),
      });

      render(<PendingLoginRoom />);
      await flush();
      // Room renders, but the unseen screen burns no Steam quota.
      expect(screen.getByText('watchWaitWaiting')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      // Back to foreground: one immediate poll, then the normal cadence.
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        value: 'prerender',
        configurable: true,
      });
    }
  });

  it('moves assistive focus into the overlay on appearance', async () => {
    setLocation('?login=waiting');
    fetchMock.mockResolvedValue({
      json: async () => ({ done: false, botProfileUrl: BOT_PROFILE }),
    });

    render(<PendingLoginRoom />);
    await flush();

    // Blocking overlay: keyboard/screen-reader context starts on its
    // heading, not behind the backdrop.
    expect(document.activeElement).toBe(screen.getByText('watchWaitTitle'));
  });

  it('escalates the poll cadence after the first minute (shared policy)', async () => {
    setLocation('?login=waiting');
    fetchMock.mockResolvedValue({
      json: async () => ({ done: false, botProfileUrl: BOT_PROFILE }),
    });

    render(<PendingLoginRoom />);
    await flush();
    // t=0 immediate + 10s tier through t=60 (6 more polls).
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    // Slow tier: nothing more at t=70–80, next lands at t=90.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('survives network blips and malformed bodies by staying in wait', async () => {
    setLocation('?login=waiting');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fetchMock.mockResolvedValueOnce({ json: async () => ({}) });

    render(<PendingLoginRoom />);
    await flush();

    // First poll threw, second returned an unrecognized shape: still
    // waiting, and the loop continues.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText('watchWaitWaiting')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

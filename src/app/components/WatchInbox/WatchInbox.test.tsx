import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchInbox from './WatchInbox';
import { WATCH_SEEN_KEY_PREFIX } from '@/app/templates/Home/hooks/watch/watchReadState';

// Interpolation-aware (unlike the key-echo mock in WatchManager tests):
// the bell aria-label carries {count}, which these tests must observe.
const mockTranslate = (key: string, values?: Record<string, unknown>) =>
  values === undefined ? key : `${key}:${JSON.stringify(values)}`;

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => mockTranslate,
}));

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const notificationsResponse = (
  rows: Array<{ id: number; sentAt: string }>,
  unreadCount?: number,
) =>
  ({
    ok: true,
    json: async () => ({
      steamId: STEAM_A,
      notifications: rows,
      ...(unreadCount === undefined ? {} : { unreadCount }),
    }),
  }) as Response;

const row = (id: number, sentAt: string) => ({ id, sentAt });

describe('WatchInbox', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  const settle = async () => {
    await act(async () => {});
  };

  const openInbox = async () => {
    fireEvent.click(screen.getByRole('button'));
    await settle();
  };

  it('fetches history for the session profile on mount (no steamId param)', async () => {
    fetchMock.mockResolvedValue(notificationsResponse([]));

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/watch/notifications?');
    expect(url).not.toContain('steamId=');
  });

  it('shows the unread count on the bell and clears it on open', async () => {
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [
          row(2, '2026-06-02T00:00:00.000Z'),
          row(1, '2026-06-01T00:00:00.000Z'),
        ],
        2,
      ),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    const bell = screen.getByRole('button');
    // Both unread, announced in the label (the badge itself is
    // aria-hidden — no double announcement).
    expect(bell).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":2}',
    );
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('2').closest('span')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    await openInbox();

    // Open marks everything visible as seen: badge gone, label at zero.
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
    expect(
      window.localStorage.getItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`),
    ).toBe('2026-06-02T00:00:00.000Z');
    // Items render newest-first with the shared base text.
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-06-02T00:00:00.000Z',
    );
  });

  it('keeps read state per steamId (no cross-profile leaks)', async () => {
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-03T00:00:00.000Z',
    );
    fetchMock.mockResolvedValue(
      notificationsResponse([row(9, '2026-06-02T00:00:00.000Z')], 0),
    );

    const { rerender } = render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    // Watermark (06-03) covers the 06-02 event: nothing unread for A…
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );

    // …and B starts clean even though A was fully read.
    fetchMock.mockResolvedValue(
      notificationsResponse([row(3, '2026-06-03T00:00:00.000Z')], 1),
    );
    rerender(<WatchInbox steamId={STEAM_B} />);
    await settle();

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/watch/notifications?'),
    );
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );
    // A's rows never mix into B's inbox: open shows exactly B's event.
    await openInbox();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-06-03T00:00:00.000Z',
    );
  });

  it('survives reloads: opened notifications stay read', async () => {
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-01T12:00:00.000Z',
    );
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [
          row(6, '2026-06-02T00:00:00.000Z'),
          row(5, '2026-06-01T00:00:00.000Z'),
        ],
        1,
      ),
    );

    const { unmount } = render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );
    unmount();

    // Remount (reload): only the 06-02 event is still unread.
    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );
  });

  it('trusts the server count past the row window (no undercount)', async () => {
    // 30 delivered, window of 20: a client-side filter would read 20.
    // The server counts past the cap, so the badge must read 30 — and the
    // sinceSentAt cursor actually travels (watermark-first fetch omits it).
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: 30 - i,
      sentAt: '2026-06-02T00:00:00.000Z',
    }));
    fetchMock.mockResolvedValue(notificationsResponse(rows, 30));

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith('/api/watch/notifications?limit=20');
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":30}',
    );
    expect(screen.getByText('30')).toBeInTheDocument();

    // Opening watermarks the latest delivery (06-02)...
    fetchMock.mockResolvedValue(notificationsResponse(rows, 0));
    await openInbox();

    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );

    // ...so the NEXT fetch carries sinceSentAt=06-02 (URL-encoded) and the
    // server reports nothing new (watermark round-trips through storage,
    // not memory).
    fireEvent.click(screen.getByRole('button'));
    await settle();
    fireEvent.click(screen.getByRole('button'));
    await settle();

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/watch/notifications?limit=20&sinceSentAt=2026-06-02T00%3A00%3A00.000Z',
    );
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('shows the empty state when nothing was delivered', async () => {
    fetchMock.mockResolvedValue(notificationsResponse([]));

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(screen.getByText('watchInboxEmpty')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('shows loading, then content', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    // Bell is up (mount fetch pending); open to see the loading state.
    await openInbox();
    expect(screen.getByText('watchInboxLoading')).toBeInTheDocument();

    await act(async () => {
      resolveFetch(
        notificationsResponse([row(1, '2026-06-01T00:00:00.000Z')], 1),
      );
    });
    await settle();
    expect(screen.queryByText('watchInboxLoading')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows an error with retry, and recovers', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(screen.getByRole('alert')).toHaveTextContent('watchInboxError');
    expect(screen.queryByText(/stack|Error: network/)).not.toBeInTheDocument();

    fetchMock.mockResolvedValue(
      notificationsResponse([row(1, '2026-06-01T00:00:00.000Z')], 1),
    );
    fireEvent.click(screen.getByText('watchInboxRetry'));
    await settle();

    expect(screen.queryByText('watchInboxError')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('offers the login gate when the session died mid-use', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    const loginLink = screen.getByText('watchLoginButton');
    expect(loginLink.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/api/auth/steam/login'),
    );
    // No badge arithmetic on an unauthenticated lane.
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('clears stale rows and count when the session dies after content loaded', async () => {
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [row(2, '2026-06-02T00:00:00.000Z')],
        1,
      ),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );

    // Session dies on the next fetch: the lane resets instead of showing
    // yesterday's rows next to a login prompt.
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await openInbox();

    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByText('watchLoginButton')).toBeInTheDocument();
  });

  it('recovers the lane when the session comes back (expiry flag resets)', async () => {
    // 401 first: login prompt, badge zeroed…
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();
    expect(screen.getByText('watchLoginButton')).toBeInTheDocument();

    // …then a successful fetch (re-login elsewhere) clears the prompt and
    // restores rows instead of sticking on the login state. (Unnamed
    // button query: the key-echo mock translator lowercases the label,
    // so no name filter can match it — the bell is the only <button>
    // while the panel shows rows or the login link.)
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [row(3, '2026-06-03T00:00:00.000Z')],
        1,
      ),
    );
    fireEvent.click(screen.getByRole('button'));
    await settle();
    fireEvent.click(screen.getByRole('button'));
    await settle();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('watchLoginButton')).not.toBeInTheDocument();
  });

  it('drops malformed rows instead of crashing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        steamId: STEAM_A,
        notifications: [
          { id: 1, sentAt: '2026-06-01T00:00:00.000Z' },
          { id: 'x', sentAt: '2026-06-01T00:00:00.000Z' },
          { id: 2 },
          null,
          'nope',
        ],
        unreadCount: 1,
      }),
    } as Response);

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('supports keyboard: aria-expanded, Escape closes, focus moves', async () => {
    fetchMock.mockResolvedValue(notificationsResponse([]));

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    const bell = screen.getByRole('button');
    expect(bell).toHaveAttribute('aria-expanded', 'false');

    // Native <button> gives Enter/Space activation for free; what needs
    // proving is the dialog stewardship: expanded state, focus in, Escape
    // out with focus back on the bell.
    bell.focus();
    fireEvent.click(bell);
    await settle();

    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('watchInboxTitle')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
  });
});

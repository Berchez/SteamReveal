import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchInbox from './WatchInbox';
import {
  WATCH_IDENTITY_EVENT,
  WATCH_IDENTITY_KEY,
} from '@/app/templates/Home/hooks/watch/watchIdentity';
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

  it('renders nothing and never fetches without an identity', async () => {
    const { container } = render(<WatchInbox />);
    await settle();

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing for an invalid stored identity', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, 'not-an-id');
    const { container } = render(<WatchInbox />);
    await settle();

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appears without reload when the identity lands mid-session', async () => {
    // The core same-tab flow: WatchManager stores the id after a
    // successful request and broadcasts (native storage events never
    // fire in the writing document). The bell must show up with no F5.
    const { container } = render(<WatchInbox />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(notificationsResponse([]));
    await act(async () => {
      window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
      window.dispatchEvent(new Event(WATCH_IDENTITY_EVENT));
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/watch/notifications?steamId=${STEAM_A}&limit=20`,
    );
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('fetches history for the stored identity on mount', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    fetchMock.mockResolvedValue(
      notificationsResponse([row(2, '2026-06-02T00:00:00.000Z')]),
    );

    render(<WatchInbox />);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/watch/notifications?steamId=${STEAM_A}&limit=20`,
    );
  });

  it('shows the unread count on the bell and clears it on open', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    fetchMock.mockResolvedValue(
      notificationsResponse([
        row(2, '2026-06-02T00:00:00.000Z'),
        row(1, '2026-06-01T00:00:00.000Z'),
      ]),
    );

    render(<WatchInbox />);
    await settle();

    const bell = screen.getByRole('button');
    // Two rows, no watermark yet: both unread, announced in the label
    // (the badge itself is aria-hidden — no double announcement).
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
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-03T00:00:00.000Z',
    );
    fetchMock.mockResolvedValue(
      notificationsResponse([row(9, '2026-06-02T00:00:00.000Z')]),
    );

    render(<WatchInbox />);
    await settle();

    // Watermark (06-03) covers the 06-02 event: nothing unread for A…
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );

    // …and B starts clean even though A was fully read.
    fetchMock.mockResolvedValue(
      notificationsResponse([row(3, '2026-06-03T00:00:00.000Z')]),
    );
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_B);
    await act(async () => {
      window.dispatchEvent(new window.StorageEvent('storage'));
    });
    await settle();

    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/watch/notifications?steamId=${STEAM_B}&limit=20`,
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
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-01T12:00:00.000Z',
    );
    fetchMock.mockResolvedValue(
      notificationsResponse([
        row(6, '2026-06-02T00:00:00.000Z'),
        row(5, '2026-06-01T00:00:00.000Z'),
      ]),
    );

    const { unmount } = render(<WatchInbox />);
    await settle();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );
    unmount();

    // Remount (reload): only event 6 is still unread.
    render(<WatchInbox />);
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
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: 30 - i,
      sentAt: '2026-06-02T00:00:00.000Z',
    }));
    fetchMock.mockResolvedValue(notificationsResponse(rows, 30));

    render(<WatchInbox />);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/watch/notifications?steamId=${STEAM_A}&limit=20`,
    );
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
      `/api/watch/notifications?steamId=${STEAM_A}&limit=20&sinceSentAt=2026-06-02T00%3A00%3A00.000Z`,
    );
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('shows the empty state when nothing was delivered', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    fetchMock.mockResolvedValue(notificationsResponse([]));

    render(<WatchInbox />);
    await settle();
    await openInbox();

    expect(screen.getByText('watchInboxEmpty')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('shows loading, then content', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<WatchInbox />);
    await settle();
    // Bell is up (mount fetch pending); open to see the loading state.
    await openInbox();
    expect(screen.getByText('watchInboxLoading')).toBeInTheDocument();

    await act(async () => {
      resolveFetch(notificationsResponse([row(1, '2026-06-01T00:00:00.000Z')]));
    });
    await settle();
    expect(screen.queryByText('watchInboxLoading')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows an error with retry, and recovers', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    fetchMock.mockRejectedValue(new Error('network down'));

    render(<WatchInbox />);
    await settle();
    await openInbox();

    expect(screen.getByRole('alert')).toHaveTextContent('watchInboxError');
    expect(screen.queryByText(/stack|Error: network/)).not.toBeInTheDocument();

    fetchMock.mockResolvedValue(
      notificationsResponse([row(1, '2026-06-01T00:00:00.000Z')]),
    );
    fireEvent.click(screen.getByText('watchInboxRetry'));
    await settle();

    expect(screen.queryByText('watchInboxError')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('drops malformed rows instead of crashing', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
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
      }),
    } as Response);

    render(<WatchInbox />);
    await settle();
    await openInbox();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('supports keyboard: aria-expanded, Escape closes, focus moves', async () => {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, STEAM_A);
    fetchMock.mockResolvedValue(notificationsResponse([]));

    render(<WatchInbox />);
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

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

// Same interception precedent as SiteNavSignIn tests: mock the underlying
// next-intl/navigation factory so the expired-session login link carries a
// deterministic preserved pathname (mirrors reality: usePathname strips
// the locale prefix, resolveLoginNext puts it back).
const mockUsePathname = jest.fn((): string | null => '/player/player-x');
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    redirect: jest.fn(),
    usePathname: () => mockUsePathname(),
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const notificationsResponse = (
  rows: Array<Record<string, unknown>>,
  unreadCount?: number,
  antiLoopToken?: string,
) =>
  ({
    ok: true,
    json: async () => ({
      steamId: STEAM_A,
      notifications: rows,
      ...(unreadCount === undefined ? {} : { unreadCount }),
      ...(antiLoopToken === undefined ? {} : { antiLoopToken }),
    }),
  }) as Response;

const row = (searchId: string, searchedAt: string, cheaterChecked = false) => ({
  searchId,
  searchedAt,
  cheaterChecked,
});

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
          row('search-2', '2026-06-02T00:00:00.000Z'),
          row('search-1', '2026-06-01T00:00:00.000Z'),
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
  });

  it('keeps read state per steamId (no cross-profile leaks)', async () => {
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-03T00:00:00.000Z',
    );
    fetchMock.mockResolvedValue(
      notificationsResponse([row('search-9', '2026-06-02T00:00:00.000Z')], 0),
    );

    const { rerender } = render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    // Watermark (06-03) covers the 06-02 search: nothing unread for A…
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );

    // …and B starts clean even though A was fully read.
    fetchMock.mockResolvedValue(
      notificationsResponse([row('search-3', '2026-06-03T00:00:00.000Z')], 1),
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
    // A's rows never mix into B's inbox: open shows exactly B's search.
    await openInbox();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
  });

  it('survives reloads: opened notifications stay read', async () => {
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-01T12:00:00.000Z',
    );
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [
          row('search-6', '2026-06-02T00:00:00.000Z'),
          row('search-5', '2026-06-01T00:00:00.000Z'),
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

    // Remount (reload): only the 06-02 search is still unread.
    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );
  });

  it('trusts the server count past the row window (no undercount)', async () => {
    // 30 searches, window of 20: a client-side filter would read 20.
    // The server counts past the cap, so the badge must read 30 — and the
    // sinceSearchedAt cursor actually travels (watermark-first fetch omits it).
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(`search-${30 - i}`, '2026-06-02T00:00:00.000Z'),
    );
    fetchMock.mockResolvedValue(notificationsResponse(rows, 30));

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith('/api/watch/notifications?limit=20');
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":30}',
    );
    expect(screen.getByText('30')).toBeInTheDocument();

    // Opening watermarks the latest search (06-02)...
    fetchMock.mockResolvedValue(notificationsResponse(rows, 0));
    await openInbox();

    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );

    // ...so the NEXT fetch carries sinceSearchedAt=06-02 (URL-encoded) and the
    // server reports nothing new (watermark round-trips through storage,
    // not memory).
    fireEvent.click(screen.getByRole('button'));
    await settle();
    fireEvent.click(screen.getByRole('button'));
    await settle();

    // Reopen renders links, so it asks for the loop-guard token (the
    // mount fetch above stays token-free — badge only).
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/watch/notifications?limit=20&sinceSearchedAt=2026-06-02T00%3A00%3A00.000Z&withToken=1',
    );
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('shows the empty state when nothing was recorded', async () => {
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
        notificationsResponse([row('search-1', '2026-06-01T00:00:00.000Z')], 1),
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
      notificationsResponse([row('search-1', '2026-06-01T00:00:00.000Z')], 1),
    );
    fireEvent.click(screen.getByText('watchInboxRetry'));
    await settle();

    expect(screen.queryByText('watchInboxError')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('clears a corrupt watermark and retries once on HTTP 400 (status, not message sniffing)', async () => {
    // Seed a corrupt cursor: the first fetch goes out WITH it and the
    // route answers 400; the retry goes out cursorless and succeeds.
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-02T12:00:00.000Z',
    );
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValue(
        notificationsResponse([row('search-1', '2026-06-01T12:00:00.000Z')], 1),
      );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('sinceSearchedAt=');
    expect(urls[1]).not.toContain('sinceSearchedAt=');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    // The corrupt cursor is gone for good: opening watermarked the
    // recorded search instead of restoring the bad value.
    expect(
      window.localStorage.getItem(`${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`),
    ).toBe('2026-06-01T12:00:00.000Z');
  });

  it('applies the cursorless retry with a null cursor (local fallback counts all rows)', async () => {
    // Same 400-then-retry as above, but the retry answer carries NO server
    // count: the local fallback must treat the fetch as cursorless
    // (count = rows landed). With the invalidated watermark still
    // attached, the 06-01 row would filter against the 06-02 cursor and
    // the badge would wrongly read 0.
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-02T12:00:00.000Z',
    );
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValue(
        notificationsResponse([row('search-1', '2026-06-01T12:00:00.000Z')]),
      );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();

    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":1}',
    );
  });

  it('renders the notify body with a real clickable player-page link', async () => {
    // Regression net: the shared bot base text used to land as one
    // collapsed run with a dead URL string (HTML eats the `\n`). The
    // inbox must preserve the line break AND link "see what they saw".
    fetchMock.mockResolvedValue(
      notificationsResponse([row('search-1', '2026-06-01T00:00:00.000Z')], 1),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    const link = screen.getByRole('link', {
      name: 'watchInboxItemViewHere',
    });
    expect(link).toHaveAttribute(
      'href',
      `http://localhost/en/player/${STEAM_A}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    // Body keeps its line break in HTML (whitespace-pre-line) instead of
    // collapsing into one run. The mock translator echoes keys, so the
    // localized plain-body key (not English prose) is the assertion.
    expect(link.closest('p')).toHaveClass('whitespace-pre-line');
    expect(link.closest('p')).toHaveTextContent(/watchInboxItemPlainBody/);
  });

  it('appends the server-minted anti-loop token to row links (self-click records nothing)', async () => {
    // The loop fix: opening your own profile from the inbox must not
    // record a fresh search (which used to notify again per click).
    const token = 'ab'.repeat(32);
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [row('search-1', '2026-06-01T00:00:00.000Z')],
        1,
        token,
      ),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(
      screen.getByRole('link', { name: 'watchInboxItemViewHere' }),
    ).toHaveAttribute(
      'href',
      `http://localhost/en/player/${STEAM_A}?anti_loop_token=${token}`,
    );
  });

  it('keeps a working token across refetches that answer null (no downgrade on reopen)', async () => {
    const token = 'cd'.repeat(32);
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [row('search-1', '2026-06-01T00:00:00.000Z')],
        1,
        token,
      ),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    const href = `http://localhost/en/player/${STEAM_A}?anti_loop_token=${token}`;
    expect(
      screen.getByRole('link', { name: 'watchInboxItemViewHere' }),
    ).toHaveAttribute('href', href);

    // Reopen without clicking: the slot is occupied now, so the server
    // answers null — the live token must survive, not be evicted.
    fetchMock.mockResolvedValue(
      notificationsResponse([row('search-1', '2026-06-01T00:00:00.000Z')], 0),
    );
    fireEvent.click(screen.getByRole('button'));
    await settle();
    fireEvent.click(screen.getByRole('button'));
    await settle();

    expect(
      screen.getByRole('link', { name: 'watchInboxItemViewHere' }),
    ).toHaveAttribute('href', href);
  });

  it('ignores a malformed anti-loop token instead of gluing it into links', async () => {
    fetchMock.mockResolvedValue(
      notificationsResponse(
        [row('search-1', '2026-06-01T00:00:00.000Z')],
        1,
        'not-a-token',
      ),
    );

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(
      screen.getByRole('link', { name: 'watchInboxItemViewHere' }),
    ).toHaveAttribute('href', `http://localhost/en/player/${STEAM_A}`);
  });

  it('shows a visible error when the retry after a 400 also fails (never silent)', async () => {
    // 400 (bad watermark) -> cursorless retry -> 500: the second failure
    // must land on the error panel with a retry affordance, not an empty
    // inbox and a cleared loading state.
    window.localStorage.setItem(
      `${WATCH_SEEN_KEY_PREFIX}${STEAM_A}`,
      '2026-06-02T12:00:00.000Z',
    );
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValue({ ok: false, status: 500 });

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(screen.getByRole('alert')).toHaveTextContent('watchInboxError');
    expect(screen.getByText('watchInboxRetry')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('offers the login gate when the session died mid-use', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    const loginLink = screen.getByText('watchLoginButton');
    // Same return-where-you-were contract as the navbar sign-in (not the
    // bare home): the expired session happened on /player/player-x.
    expect(loginLink.closest('a')).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2Fplayer%2Fplayer-x',
    );
    // No badge arithmetic on an unauthenticated lane.
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'watchInboxBellLabel:{"count":0}',
    );
  });

  it('clears stale rows and count when the session dies after content loaded', async () => {
    fetchMock.mockResolvedValue(
      notificationsResponse([row('search-2', '2026-06-02T00:00:00.000Z')], 1),
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
      notificationsResponse([row('search-3', '2026-06-03T00:00:00.000Z')], 1),
    );
    fireEvent.click(screen.getByRole('button'));
    await settle();
    fireEvent.click(screen.getByRole('button'));
    await settle();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('watchLoginButton')).not.toBeInTheDocument();
  });

  it('drops legacy pre-split rows instead of rendering half-true times', async () => {
    // Old servers mid-rollout still answer id+sentAt shapes. searchId AND
    // searchedAt are both the identity and the time anchor, so these rows
    // fall out entirely: no row is better than a row with a wrong when.
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
        unreadCount: 0,
      }),
    } as Response);

    render(<WatchInbox steamId={STEAM_A} />);
    await settle();
    await openInbox();

    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByText('watchInboxEmpty')).toBeInTheDocument();
  });

  it('shows per-session details and the monthly badge', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        steamId: STEAM_A,
        notifications: [
          {
            searchId: 'search-9',
            searchedAt: '2026-06-02T11:58:00.000Z',
            cheaterChecked: true,
          },
          {
            searchId: 'search-7',
            searchedAt: '2026-06-01T00:00:00.000Z',
            cheaterChecked: false,
          },
        ],
        unreadCount: 0,
        monthlyCount: 11,
      }),
    } as Response);

    render(<WatchInbox steamId={STEAM_A} />);
    await openInbox();

    // Monthly badge, absolute top-right of the dialog.
    const badge = screen.getByLabelText('watchInboxMonthlyBadge:{"count":11}');
    expect(badge).toHaveTextContent('watchInboxMonthlyBadge:{"count":11}');

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
  });

  it('hides the monthly badge when the server sends no count', async () => {
    fetchMock.mockResolvedValue(notificationsResponse([], 0));

    render(<WatchInbox steamId={STEAM_A} />);
    await openInbox();

    expect(
      screen.queryByText(/watchInboxMonthlyBadge/),
    ).not.toBeInTheDocument();
  });

  it('drops rows with corrupt search fields instead of crashing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        steamId: STEAM_A,
        notifications: [
          // Missing searchId, garbage searchedAt, non-string searchedAt:
          // all dropped. Only the well-formed row renders; its non-boolean
          // flag hides the cheater line; negative monthly count hides the
          // badge.
          { searchedAt: '2026-06-01T00:00:00.000Z' },
          { searchId: 'search-bad', searchedAt: 'not-a-date' },
          { searchId: '', searchedAt: '2026-06-01T00:00:00.000Z' },
          {
            searchId: 'search-1',
            searchedAt: '2026-06-01T00:00:00.000Z',
            cheaterChecked: 'yes',
          },
        ],
        unreadCount: 0,
        monthlyCount: -3,
      }),
    } as Response);

    render(<WatchInbox steamId={STEAM_A} />);
    await openInbox();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    expect(
      screen.queryByText(/watchInboxMonthlyBadge/),
    ).not.toBeInTheDocument();
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

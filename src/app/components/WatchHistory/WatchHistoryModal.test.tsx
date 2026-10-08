import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchHistoryModal from './WatchHistoryModal';
import { HISTORY_PAGE_SIZE } from '@/lib/analytics/historyLimits';

const mockTranslate = (key: string, params?: Record<string, unknown>) => {
  if (params !== undefined) {
    return `${key} ${JSON.stringify(params)}`;
  }
  return key;
};

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => mockTranslate,
}));

// Same interception precedent as WatchManager.test.tsx: mock the
// underlying next-intl/navigation factory (not the @/navigation alias).
// The mock Link renders the UNPREFIXED href — pinning that the modal
// passes locale-agnostic paths and lets next-intl add the prefix (P2-8).
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children, ...rest }: any) => (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
    redirect: jest.fn(),
    usePathname: () => '/player/player-c',
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

jest.mock(
  '@/app/templates/Home/shared/analytics/loginFunnel',
  () => ({
    recordLoginCta: jest.fn(),
  }),
);

const { recordLoginCta } = jest.requireMock(
  '@/app/templates/Home/shared/analytics/loginFunnel',
) as { recordLoginCta: jest.Mock };

const historyPayload = (
  entries: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  ok: true,
  status: 200,
  json: async () => ({ entries, nextCursor: null, total: entries.length, ...extra }),
});

const entry = (searchId: string, steamId: string, nickname: string | null) => ({
  searchId,
  searchedAt: '2026-09-30T00:00:00.000Z',
  steamId,
  nickname,
  steamUrl: null,
  countryCode: null,
  cheaterChecked: false,
});

describe('WatchHistoryModal', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    global.fetch = jest.fn(async () =>
      historyPayload([], { total: 0 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the session-scoped history without any id in the URL', async () => {
    const fetchMock = global.fetch as jest.Mock;
    render(<WatchHistoryModal onClose={jest.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`/api/history?limit=${HISTORY_PAGE_SIZE}`);
    expect(url).not.toContain('steamId');
  });

  it('renders one row per searched profile with a player link and the date', async () => {
    global.fetch = jest.fn(async () =>
      historyPayload(
        [
          { ...entry('s1', '76561198000000002', 'Bob'), cheaterChecked: true },
          entry('s2', '76561198000000003', null),
        ],
        { total: 2 },
      ),
    ) as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    // Locale-agnostic href in, locale prefix out (next-intl owns it).
    expect(screen.getByText('Bob').closest('a')).toHaveAttribute(
      'href',
      '/player/76561198000000002',
    );
    // Null nickname falls back to the raw id (still linkable).
    expect(screen.getByText('76561198000000003')).toBeInTheDocument();
    // Cheater flag rides next to the date, never instead of it.
    expect(screen.getByText('watchInboxCheaterChecked')).toBeInTheDocument();
    expect(screen.getAllByText(/\/2026,/)).toHaveLength(2);
  });

  it('shows the empty state when nothing was recorded under this login', async () => {
    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('watchHistoryEmpty')).toBeInTheDocument();
  });

  it('shows the opted-out empty copy when new searches are not attributed', async () => {
    // Session alive, footprint gone: the standard "searches will appear
    // here" would promise recordings that never come.
    global.fetch = jest.fn(async () =>
      historyPayload([], { total: 0, attributing: false }),
    ) as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(
      await screen.findByText('watchHistoryEmptyOptedOut'),
    ).toBeInTheDocument();
    expect(screen.queryByText('watchHistoryEmpty')).not.toBeInTheDocument();
  });

  it('closes the modal when navigating to a history item', async () => {
    // SiteNavMenu lives in the layout and never unmounts on client-side
    // navigation: without this the player page would load behind the
    // overlay (with the body scroll still locked).
    global.fetch = jest.fn(async () =>
      historyPayload([entry('s1', '76561198000000002', 'Bob')], { total: 1 }),
    ) as unknown as typeof fetch;

    const onClose = jest.fn();
    render(<WatchHistoryModal onClose={onClose} />);

    fireEvent.click(await screen.findByText('Bob'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('discloses collection at the point of the feature (P1-3)', async () => {
    // The LoginPrompt line only reaches pre-login users; logged-in
    // viewers meet this notice instead: what is stored, how long, how
    // to erase.
    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('watchHistoryEmpty')).toBeInTheDocument();
    expect(screen.getByText('watchHistoryPrivacyNote')).toBeInTheDocument();
  });

  it('scopes the scrollbar gutter while open (no site-wide shift)', async () => {
    // Tall page (scrolls): the class reserves the gutter while locked.
    // jsdom exposes these as prototype getters, so the fakes are own
    // props DELETED afterwards (restoring a descriptor snapshot would
    // keep the fake, leaking layout into every later test).
    const element = document.documentElement as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperties(document.documentElement, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 800, configurable: true },
    });
    try {
      expect(document.documentElement.classList.contains('modal-open')).toBe(
        false,
      );

      const { unmount } = render(<WatchHistoryModal onClose={jest.fn()} />);
      expect(document.documentElement.classList.contains('modal-open')).toBe(
        true,
      );
      await screen.findByText('watchHistoryTitle');

      unmount();
      expect(document.documentElement.classList.contains('modal-open')).toBe(
        false,
      );
    } finally {
      delete element.scrollHeight;
      delete element.clientHeight;
    }
  });

  it('skips the gutter class on short pages (nothing to stabilize)', async () => {
    // jsdom has no layout (scrollHeight 0): the class must stay off —
    // reserving space on a page without a scrollbar IS the shift.
    const { unmount } = render(<WatchHistoryModal onClose={jest.fn()} />);
    await screen.findByText('watchHistoryTitle');

    expect(document.documentElement.classList.contains('modal-open')).toBe(
      false,
    );
    unmount();
  });
  it('discloses the opt-out coupling where history is managed (P1-5)', async () => {
    // Unfriending the bot also cuts these links (kept coupled by product
    // decision) — the modal says so, on both the empty and the listed
    // state, so the loss is never silent.
    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('watchHistoryEmpty')).toBeInTheDocument();
    expect(screen.getByText('watchHistoryOptOutNote')).toBeInTheDocument();
  });

  it('recovers from a failed load through retry', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    const retry = await screen.findByText('watchHistoryRetry');
    fetchMock.mockResolvedValueOnce(
      historyPayload([entry('s1', '76561198000000002', 'Bob')], { total: 1 }),
    );
    await act(async () => {
      fireEvent.click(retry);
    });

    expect(await screen.findByText('Bob')).toBeInTheDocument();
  });

  it('offers sign-in again when the session expired mid-use', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    // Own message (not the generic login-failure text): the session
    // expired, the login did not fail.
    expect(
      await screen.findByText('watchHistorySessionExpired'),
    ).toBeInTheDocument();
    const login = screen.getByText('watchLoginButton');
    // Preserves the page (same contract as WatchManager) and attributes
    // the funnel CTA.
    expect(login.closest('a')).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2Fplayer%2Fplayer-c',
    );
    fireEvent.click(login);
    expect(recordLoginCta).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', async () => {
    const onClose = jest.fn();
    render(<WatchHistoryModal onClose={onClose} />);

    await screen.findByText('watchHistoryTitle');
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('appends the next page by server-built cursor without wiping the list', async () => {
    const fetchMock = jest.fn(async (url: string) =>
      url.includes('cursor=')
        ? historyPayload([entry('s2', '76561198000000003', 'Cid')], {
            nextCursor: null,
            total: null,
          })
        : historyPayload([entry('s1', '76561198000000002', 'Bob')], {
            nextCursor: '2026-09-30T00:00:00.000Z|s1',
            total: 2,
          }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();

    const more = screen.getByText('watchHistoryLoadMore');
    fireEvent.click(more);

    await waitFor(() => {
      const calls = (fetchMock as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // The cursor goes back opaquely — the client never builds the
      // "searchedAt|searchId" format itself.
      expect(String(calls[1][0])).toContain(
        'cursor=2026-09-30T00%3A00%3A00.000Z%7Cs1',
      );
    });
    // First-page row survives the append (no list wipe into a spinner),
    // the first-page total feeds the note, and the exhausted bookmark
    // retires the button (no eternal load-more).
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(await screen.findByText('Cid')).toBeInTheDocument();
    expect(screen.queryByText('watchHistoryLoadMore')).not.toBeInTheDocument();
    expect(
      screen.getByText('watchHistoryShowing {"shown":2,"total":2}'),
    ).toBeInTheDocument();
  });

  it('keeps the rows and retries inline when load-more fails', async () => {
    const fetchMock = jest.fn(async (url: string) =>
      url.includes('cursor=')
        ? { ok: false, status: 500 }
        : historyPayload([entry('s1', '76561198000000002', 'Bob')], {
            nextCursor: 'cursor-p2',
            total: 2,
          }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    fireEvent.click(screen.getByText('watchHistoryLoadMore'));

    // Inline failure (rows intact, full-panel error NOT shown — the
    // load-more button yields to the inline retry), then retry re-fires
    // the same bookmarked page.
    const retry = await screen.findByText('watchHistoryRetry');
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('watchHistoryLoadMore')).not.toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(
      historyPayload([entry('s2', '76561198000000003', 'Cid')], {
        nextCursor: null,
        total: null,
      }),
    );
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(await screen.findByText('Cid')).toBeInTheDocument();
  });

  it('keeps the rows and offers sign-in inline when the session dies mid-paging', async () => {
    const fetchMock = jest.fn(async (url: string) =>
      url.includes('cursor=')
        ? { ok: false, status: 401 }
        : historyPayload([entry('s1', '76561198000000002', 'Bob')], {
            nextCursor: 'cursor-p2',
            total: 1,
          }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    fireEvent.click(screen.getByText('watchHistoryLoadMore'));

    // Rows stay; the expired-session gate renders inline (with the
    // page-preserving login link), never as a list wipe.
    const login = await screen.findByText('watchLoginButton');
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(
      screen.getByText('watchHistorySessionExpired'),
    ).toBeInTheDocument();
    expect(login.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/api/auth/steam/login?next='),
    );
  });

  it('clears history only on the second tap (two-step, no native confirm)', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ cleared: 2 }) };
      }
      return historyPayload(
        [entry('s1', '76561198000000002', 'Bob')],
        { total: 1 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();

    // First tap only arms — no request leaves, the label switches.
    // (Time is controlled: a real double-tap inside 400ms is an
    // accidental gesture, not consent — covered below.)
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const clear = screen.getByText('watchHistoryClear');
    await act(async () => {
      fireEvent.click(clear);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('watchHistoryClearConfirm')).toBeInTheDocument();

    // Second tap executes: list empties into the empty state.
    nowSpy.mockReturnValue(1_000_500);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClearConfirm'));
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    nowSpy.mockRestore();
    const deleteCall = (fetchMock as jest.Mock).mock.calls[1];
    expect(String(deleteCall[0])).toBe('/api/history');
    expect(deleteCall[1]).toMatchObject({ method: 'DELETE' });
    expect(await screen.findByText('watchHistoryEmpty')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('ignores a double-tap that arms and executes faster than a human can read', async () => {
    // P2-5: without the 400ms floor, a fast double-click would arm AND
    // execute before the confirm label is even readable.
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ cleared: 2 }) };
      }
      return historyPayload(
        [entry('s1', '76561198000000002', 'Bob')],
        { total: 1 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClear'));
    });
    // 100ms later: still the same accidental gesture — ignored, stays armed.
    nowSpy.mockReturnValue(2_000_100);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClearConfirm'));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('watchHistoryClearConfirm')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    nowSpy.mockRestore();
  });

  it('disarms the clear confirm after a few seconds (no armed-forever delete)', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async () =>
      historyPayload([entry('s1', '76561198000000002', 'Bob')], { total: 1 }),
    ) as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClear'));
    });
    expect(screen.getByText('watchHistoryClearConfirm')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    // Back to the safe label — a later accidental tap re-arms instead
    // of executing.
    expect(screen.getByText('watchHistoryClear')).toBeInTheDocument();
    expect(
      screen.queryByText('watchHistoryClearConfirm'),
    ).not.toBeInTheDocument();
  });

  it('shows the login gate when clearing with an expired session', async () => {
    // A dead session at DELETE time gets the recovery path (page-
    // preserving login), not the generic "could not clear" text.
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 401 };
      }
      return historyPayload(
        [entry('s1', '76561198000000002', 'Bob')],
        { total: 1 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClear'));
    });
    nowSpy.mockReturnValue(3_000_500);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClearConfirm'));
    });
    nowSpy.mockRestore();

    expect(
      await screen.findByText('watchHistorySessionExpired'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('watchLoginButton').closest('a'),
    ).toHaveAttribute(
      'href',
      expect.stringContaining('/api/auth/steam/login?next='),
    );
  });

  it('aborts an in-flight load-more when clearing (no erased-row comeback)', async () => {
    // Clear × load-more race: without the abort, the late page response
    // repopulates the list with rows the server just de-attributed.
    let releasePage!: () => void;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ cleared: 2 }),
        });
      }
      if (String(url).includes('cursor=')) {
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          releasePage = () =>
            resolve(
              historyPayload(
                [entry('s2', '76561198000000003', 'Cid')],
                { nextCursor: null, total: null },
              ),
            );
        });
      }
      return Promise.resolve(
        historyPayload([entry('s1', '76561198000000002', 'Bob')], {
          nextCursor: 'cursor-p2',
          total: 2,
        }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    fireEvent.click(screen.getByText('watchHistoryLoadMore'));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(4_000_000);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClear'));
    });
    nowSpy.mockReturnValue(4_000_500);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClearConfirm'));
    });
    nowSpy.mockRestore();
    expect(await screen.findByText('watchHistoryEmpty')).toBeInTheDocument();

    // The late page lands after the clear: aborted means ignored (Cid
    // never appears, no unhandled rejection either).
    await act(async () => {
      releasePage();
    });
    expect(screen.queryByText('Cid')).not.toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    expect(screen.getByText('watchHistoryEmpty')).toBeInTheDocument();
  });

  it('surfaces the clear failure with its own message (rows stay saved)', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 500 };
      }
      return historyPayload(
        [entry('s1', '76561198000000002', 'Bob')],
        { total: 1 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WatchHistoryModal onClose={jest.fn()} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClear'));
    });
    nowSpy.mockReturnValue(5_000_500);
    await act(async () => {
      fireEvent.click(screen.getByText('watchHistoryClearConfirm'));
    });
    nowSpy.mockRestore();

    // The rows stay (nothing was cleared) with the DELETE-specific
    // message — never the load error text.
    expect(await screen.findByText('watchHistoryClearError')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('watchHistoryError')).not.toBeInTheDocument();
    expect(screen.queryByText('watchHistoryRetry')).not.toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchManager from './WatchManager';
import { clearWatchStatusPrefetch } from '@/app/templates/Home/hooks/watch/watchStatusPrefetch';

// Login-funnel beacon is mocked (not fetch-mocked like SiteNavSignIn's
// dedicated test): here we only pin THAT the gate's login link fires it.
jest.mock(
  '@/app/templates/Home/shared/analytics/loginFunnel',
  () => ({
    recordLoginCta: jest.fn(),
  }),
);

const { recordLoginCta } = jest.requireMock(
  '@/app/templates/Home/shared/analytics/loginFunnel',
) as { recordLoginCta: jest.Mock };

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

// Same interception precedent as UserCard.test.tsx: mock the underlying
// next-intl/navigation factory (not the @/navigation alias) so the
// login-link `next` preservation is deterministic in tests.
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    redirect: jest.fn(),
    usePathname: () => '/player/player-c',
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

const STEAM_ID = '76561198000000001';

// Signup shape: the manager only reads res.ok (the status poll picks up
// pending/active by itself) — overrides still merge for future needs.
const postOk = (overrides = {}) =>
  ({
    ok: true,
    json: async () => ({ ok: true, ...overrides }),
  }) as Response;

const statusResponse = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    ok: true,
    json: async () => ({ steamId: STEAM_ID, status, ...extra }),
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
    clearWatchStatusPrefetch();
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
      if (url.includes('/api/auth/signup')) return postOk();
      return statusResponse('pending');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(3);

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/auth/signup'),
      ),
    ).toHaveLength(0);
    expect(screen.getByText('watchPendingTitle')).toBeInTheDocument();
  });

  it('starts watching on explicit click (locale only, never a typed id)', async () => {
    const fetchMock = fetchByUrl((url) => {
      if (url.includes('/api/auth/signup')) return postOk();
      return statusResponse('none');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    expect(screen.getByText('watchTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('watchSubmit'));
    await settle();

    const posted = fetchMock.mock.calls.find(([calledUrl]) =>
      String(calledUrl).includes('/api/auth/signup'),
    ) as unknown as [string, RequestInit];
    expect(posted).toBeDefined();
    // Self-scoped: locale travels, identity never leaves the session.
    expect(JSON.parse(posted[1].body as string)).toEqual({ locale: 'pt' });
  });

  it('rides pending to active via polling', async () => {
    const statuses = ['pending', 'pending', 'active'];
    fetchByUrl((url) => {
      if (url.includes('/api/auth/signup')) return postOk();
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
      if (url.includes('/api/auth/signup')) return postOk();
      return statusResponse('none');
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(4);

    expect(screen.getByText('watchTitle')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/auth/signup'),
      ),
    ).toHaveLength(0);
  });

  it('shows a request error without blocking the status screens', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/auth/signup')) {
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
      if (url.includes('/api/auth/signup')) return postOk();
      return { ok: false, status: 401 } as Response;
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(2);

    const loginLink = screen.getByText('watchLoginButton');
    // Re-login preserves the page the user was on, not the home page.
    expect(loginLink.closest('a')).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fpt%2Fplayer%2Fplayer-c',
    );
  });

  it('fires the login-CTA beacon when the gate link is clicked (funnel parity with the navbar)', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/auth/signup')) return postOk();
      return { ok: false, status: 401 } as Response;
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(2);

    // Every entry to /api/auth/steam/login must record the CTA click, or
    // the conversion rate counts completions without clicks (>100%).
    fireEvent.click(screen.getByText('watchLoginButton').closest('a')!);
    await settle();

    expect(recordLoginCta).toHaveBeenCalledTimes(1);
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
      if (url.includes('/api/auth/signup')) return postOk();
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

  it('shows logout on the none screen (logged in, no watch row)', async () => {
    // Regression: the none screen used to hide logout entirely, leaving a
    // logged-in user with no watch row no in-UI way to sign out (only
    // hand-clearing site cookies). Status none must offer both Start and
    // logout side by side.
    const fetchMock = fetchByUrl((url) => {
      if (url.includes('/api/auth/signup')) return postOk();
      if (url.includes('/api/auth/logout')) {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return statusResponse('none');
    });
    const reload = jest.fn();
    const locationSpy = jest
      .spyOn(window, 'location', 'get')
      .mockReturnValue({ reload } as unknown as Location);

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(2);
    expect(screen.getByText('watchTitle')).toBeInTheDocument();

    // Both actions coexist on the same row: logout left, Start right
    // (single flex parent) — the logged-in user with no watch row can
    // either subscribe or sign out without hand-clearing cookies.
    const logoutButton = screen.getByText('watchLogout');
    const submitButton = screen.getByText('watchSubmit');
    expect(logoutButton.parentElement).toBe(submitButton.parentElement);

    // Both actions coexist: starting a watch must not fire logout, and
    // logging out must POST the logout lane exactly once.
    fireEvent.click(logoutButton);
    await settle();

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/auth/logout'),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/auth/signup'),
      ),
    ).toHaveLength(0);
    expect(reload).toHaveBeenCalledTimes(1);
    locationSpy.mockRestore();
  });

  it('shows the resend UI only when the link expired', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/auth/confirm-resend')) {
        return {
          ok: true,
          json: async () => ({ ok: true, queued: true }),
        } as Response;
      }
      return statusResponse('pending', { confirmExpired: true });
    });

    const { unmount } = render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    expect(screen.getByText('watchLinkExpired')).toBeInTheDocument();
    expect(screen.getByText('watchResendSubmit')).toBeInTheDocument();
    unmount();

    fetchByUrl(() => statusResponse('pending', { confirmExpired: false }));
    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    expect(screen.queryByText('watchLinkExpired')).not.toBeInTheDocument();
    expect(screen.queryByText('watchResendSubmit')).not.toBeInTheDocument();
  });

  it('shows watchLinkSentHint when confirmLinkSent=true and confirmExpired=false', async () => {
    // Fresh token issued, user hasn't clicked resend
    fetchByUrl(() =>
      statusResponse('pending', {
        confirmExpired: false,
        confirmLinkSent: true,
      }),
    );

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);

    expect(screen.getByText('watchLinkSentHint')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSent')).not.toBeInTheDocument();
    expect(screen.queryByText('watchPendingHint')).not.toBeInTheDocument();
  });

  it('shows watchPendingHint when confirmLinkSent=false, confirmExpired=false', async () => {
    // No token issued yet, just pending invite
    fetchByUrl(() =>
      statusResponse('pending', {
        confirmExpired: false,
        confirmLinkSent: false,
      }),
    );

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);

    expect(screen.getByText('watchPendingHint')).toBeInTheDocument();
    expect(screen.queryByText('watchLinkSentHint')).not.toBeInTheDocument();
    expect(screen.queryByText('watchResendSent')).not.toBeInTheDocument();
  });

  it('shows watchLinkSentHint (not watchResendSent) after the requested link arrives', async () => {
    // Simulate: token expired -> user clicks resend -> new token issued.
    // The expired→live flip IS the delivery signal: the local "sent"
    // state must yield to "check your chat". (A confirmLinkSent edge
    // cannot mark this — the dead token already reports linkSent=true
    // while the user waits.)
    let expired = true;
    fetchByUrl((url) => {
      if (url.includes('/api/auth/confirm-resend')) {
        return {
          ok: true,
          json: async () => ({ ok: true, queued: true }),
        } as Response;
      }
      return statusResponse('pending', { confirmExpired: expired, confirmLinkSent: true });
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    expect(screen.getByText('watchLinkExpired')).toBeInTheDocument();
    expect(screen.getByText('watchResendSubmit')).toBeInTheDocument();

    // User clicks resend
    fireEvent.click(screen.getByText('watchResendSubmit'));
    await settle();
    expect(screen.getByText('watchResendSent')).toBeInTheDocument();

    // New token issued (expired=false, confirmLinkSent stays true)
    expired = false;
    await flushPolls(1);

    expect(screen.getByText('watchLinkSentHint')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSent')).not.toBeInTheDocument();
    expect(screen.queryByText('watchResendSubmit')).not.toBeInTheDocument();
  });

  it('shows watchResendSent when confirmExpired=true and user has clicked resend', async () => {
    // Simulate: token expired -> user clicks resend -> token still expired (new token not live yet)
    let expired = true;
    fetchByUrl((url) => {
      if (url.includes('/api/auth/confirm-resend')) {
        return {
          ok: true,
          json: async () => ({ ok: true, queued: true }),
        } as Response;
      }
      return statusResponse('pending', { confirmExpired: expired, confirmLinkSent: true });
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    expect(screen.getByText('watchLinkExpired')).toBeInTheDocument();
    expect(screen.getByText('watchResendSubmit')).toBeInTheDocument();

    // User clicks resend
    fireEvent.click(screen.getByText('watchResendSubmit'));
    await settle();

    // Token still expired (new token not live yet)
    // Both the conditional paragraph and the confirmExpired+resendSent block should show watchResendSent
    expect(screen.getByText('watchResendSent')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSubmit')).not.toBeInTheDocument();
  });

  it('requests a fresh link and confirms on success (no signup fired)', async () => {
    const fetchMock = fetchByUrl((url) => {
      if (url.includes('/api/auth/confirm-resend')) {
        return {
          ok: true,
          json: async () => ({ ok: true, queued: true }),
        } as Response;
      }
      return statusResponse('pending', { confirmExpired: true });
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);

    fireEvent.click(screen.getByText('watchResendSubmit'));
    await settle();

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/auth/confirm-resend'),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/auth/signup'),
      ),
    ).toHaveLength(0);
    expect(screen.getByText('watchResendSent')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSubmit')).not.toBeInTheDocument();
  });

  it('shows a request error when the resend fails (no sent state)', async () => {
    fetchByUrl((url) => {
      if (url.includes('/api/auth/confirm-resend')) {
        return { ok: false, status: 500 } as Response;
      }
      return statusResponse('pending', { confirmExpired: true });
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);

    fireEvent.click(screen.getByText('watchResendSubmit'));
    await settle();

    expect(screen.getByText('watchErrorFailed')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSent')).not.toBeInTheDocument();
    // Still pending with a live resend path: the button stays for retry.
    expect(screen.getByText('watchResendSubmit')).toBeInTheDocument();
  });

  it('offers the button again on a second expiry cycle (resendSent resets on flip)', async () => {
    // Regression net: without the flip-reset, a second dead generation in
    // the same long-lived mount would never offer the button again.
    // confirmLinkSent tracks the expiry (a live token exists exactly when
    // the state is not expired) so the post-delivery hint is faithful.
    let expired = true;
    fetchByUrl((url) => {
      if (url.includes('/api/auth/confirm-resend')) {
        return {
          ok: true,
          json: async () => ({ ok: true, queued: true }),
        } as Response;
      }
      return statusResponse('pending', {
        confirmExpired: expired,
        confirmLinkSent: !expired,
      });
    });

    render(<WatchManager steamId={STEAM_ID} />);
    await flushPolls(1);
    fireEvent.click(screen.getByText('watchResendSubmit'));
    await settle();
    expect(screen.getByText('watchResendSent')).toBeInTheDocument();

    // Fresh token issued: polls report it live. The expired→live flip is
    // the delivery signal, so the stale "on its way" yields to the live
    // "check your chat" hint (no premature reset before that: the
    // confirmation above survived every poll while expired stayed true).
    expired = false;
    await flushPolls(1);
    expect(screen.getByText('watchLinkSentHint')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSent')).not.toBeInTheDocument();
    expect(screen.queryByText('watchResendSubmit')).not.toBeInTheDocument();

    // That generation dies unclicked too: the button must come back.
    expired = true;
    await flushPolls(1);
    expect(screen.getByText('watchResendSubmit')).toBeInTheDocument();
    expect(screen.queryByText('watchResendSent')).not.toBeInTheDocument();
  });

  it('shows a height-neutral skeleton while the first poll is in flight', async () => {
    // The fetch never settles: status stays null, so the loading path must
    // hold the dropdown height instead of rendering nothing (the CLS fix).
    fetchByUrl(() => new Promise<Response>(() => undefined));

    render(<WatchManager steamId={STEAM_ID} />);
    await settle();

    const skeleton = screen.getByTestId('watch-manager-skeleton');
    expect(skeleton).toBeInTheDocument();
    // Same wrapper as the real states: the poll swap changes content, not size.
    expect(skeleton).toHaveClass(
      'w-full',
      'max-w-xl',
      'mx-auto',
      'flex-col',
      'gap-y-6',
    );
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton.textContent).toBe('');
  });

  it('paints server-seeded content immediately, skipping the skeleton', async () => {
    // SSR-seed from SiteNav: the first paint already shows the real state
    // even though the mount poll never resolves.
    fetchByUrl(() => new Promise<Response>(() => undefined));

    render(
      <WatchManager
        steamId={STEAM_ID}
        initialWatch={{
          status: 'pending',
          confirmExpired: false,
          confirmLinkSent: true,
        }}
      />,
    );
    await settle();

    expect(screen.getByText('watchPendingTitle')).toBeInTheDocument();
    expect(
      screen.queryByTestId('watch-manager-skeleton'),
    ).not.toBeInTheDocument();
  });
});

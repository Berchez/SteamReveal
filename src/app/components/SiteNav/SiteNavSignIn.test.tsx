import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import SiteNavSignIn from './SiteNavSignIn';

jest.mock('next-intl', () => ({
  useLocale: () => 'pt',
  useTranslations: () => (key: string) => key,
}));

// Same interception precedent as UserCard.test.tsx: mock the underlying
// next-intl/navigation factory so the preserved pathname is deterministic.
// Mirrors reality: next-intl's usePathname strips the locale prefix, the
// helper puts it back — the href always carries the full localized path.
const mockUsePathname = jest.fn((): string | null => '/player/player-c');
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    redirect: jest.fn(),
    usePathname: () => mockUsePathname(),
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

describe('SiteNavSignIn', () => {
  it('preserves the current page as the post-login destination', () => {
    render(<SiteNavSignIn botOnline />);

    expect(
      screen.getByRole('link', { name: 'watchNavSignIn' }),
    ).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fpt%2Fplayer%2Fplayer-c',
    );
  });

  it('falls back to the locale home without a pathname', () => {
    mockUsePathname.mockReturnValueOnce(null);
    render(<SiteNavSignIn botOnline />);

    expect(
      screen.getByRole('link', { name: 'watchNavSignIn' }),
    ).toHaveAttribute('href', '/api/auth/steam/login?next=%2Fpt%2F');
  });

  it('renders ONLY the sign-in pill (login-first: no separate add-bot step)', () => {
    render(<SiteNavSignIn botOnline />);

    // The add-the-bot step moved into the waiting room: a single link
    // here, never a chip + pill pair.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(
      screen.getByRole('link', { name: 'watchNavSignIn' }),
    ).toBeInTheDocument();
  });

  it('renders NOTHING when the bot is offline (absence, not a disabled pill)', () => {
    const { container } = render(<SiteNavSignIn botOnline={false} />);

    // No sign-in entry at all: a user must never burn a Steam login
    // round-trip while the bot cannot complete it.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('fires the fire-and-forget login CTA beacon on click (navigation untouched)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      render(<SiteNavSignIn botOnline />);

      const link = screen.getByRole('link', { name: 'watchNavSignIn' });
      fireEvent.click(link);

      // Beacon first: anon session + (null) search correlation, keepalive so
      // it survives the redirect that follows immediately after.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/recordAnalyticsLogin');
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.event).toBe('login_cta_clicked');
      expect(typeof body.sessionId).toBe('string');
      expect(body.searchId).toBeNull();
      // The pill still points at Steam: instrumentation never hijacks it.
      expect(link).toHaveAttribute(
        'href',
        '/api/auth/steam/login?next=%2Fpt%2Fplayer%2Fplayer-c',
      );
    } finally {
      // finally, not a trailing delete: a failed assertion above must not
      // leak the fetch mock into the next test.
      delete (global as Record<string, unknown>).fetch;
    }
  });
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import LoginPrompt from './LoginPrompt';
import { useTranslations, useLocale } from 'next-intl';

// Mock the `useTranslations`/`useLocale` hooks from `next-intl` (same
// SponsorMe precedent: key-echo translator).
jest.mock('next-intl', () => ({
  useLocale: jest.fn(() => 'en'),
  useTranslations: jest.fn(),
}));

// Same interception precedent as UserCard/SiteNavSignIn tests: mock the
// underlying next-intl/navigation factory (NOT the @/navigation alias),
// so usePathname is deterministic.
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    redirect: jest.fn(),
    usePathname: () => '/player/player-c',
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

// resolveLoginNext is intentionally real (like SiteNavSignIn tests): with
// the mocked pathname/locale above it yields '/en/player/player-c'.

describe('LoginPrompt component', () => {
  const mockOnClose = jest.fn();
  const mockDontAskAgain = jest.fn();

  type TranslationKeys =
    | 'title'
    | 'description'
    | 'benefitWatch'
    | 'benefitBanAlerts'
    | 'benefitEarlyAccess'
    | 'signInButton'
    | 'dontAskAgain'
    // `feedback.close` (reused for the dismiss-button aria-label, so no
    // new locale key was needed) flows through the same mocked hook.
    | 'close';

  beforeEach(() => {
    (useLocale as jest.Mock).mockReturnValue('en');
    (useTranslations as jest.Mock).mockReturnValue((key: TranslationKeys) => {
      const translations: Record<TranslationKeys, string> = {
        title: 'Get more from SteamReveal',
        description: 'Sign in to unlock more.',
        benefitWatch: 'Watch alerts',
        benefitBanAlerts: 'Ban alerts',
        benefitEarlyAccess: 'Early access',
        signInButton: 'Sign in with Steam',
        dontAskAgain: "Don't ask again",
        close: 'Close',
      };
      return translations[key];
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders title, description, all three benefits and the sign-in CTA', () => {
    render(<LoginPrompt onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    expect(screen.getByText('Get more from SteamReveal')).toBeInTheDocument();
    expect(screen.getByText('Sign in to unlock more.')).toBeInTheDocument();
    expect(screen.getByText('Watch alerts')).toBeInTheDocument();
    expect(screen.getByText('Ban alerts')).toBeInTheDocument();
    expect(screen.getByText('Early access')).toBeInTheDocument();
    expect(screen.getByText('Sign in with Steam').closest('a')).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2Fplayer%2Fplayer-c',
    );
  });

  it('fires the shown beacon exactly once per display', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      render(<LoginPrompt onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([url, init]) =>
              url === '/api/recordAnalyticsLogin' &&
              JSON.parse((init as RequestInit).body as string).event ===
                'login_popup_shown',
          ),
        ).toHaveLength(1);
      });
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('fires the popup CTA beacon (not the navbar one) on sign-in click', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      render(<LoginPrompt onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);
      // Let the shown-beacon effect settle first so the click assertion
      // below counts exactly one CTA call.
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      fireEvent.click(screen.getByText('Sign in with Steam'));

      const ctaCalls = fetchMock.mock.calls.filter(
        ([, init]) =>
          JSON.parse((init as RequestInit).body as string).event ===
          'login_popup_cta_clicked',
      );
      expect(ctaCalls).toHaveLength(1);
      // The navbar CTA event must never fire from this surface (it would
      // pollute the funnel panel's click metric).
      const navbarCalls = fetchMock.mock.calls.filter(
        ([, init]) =>
          JSON.parse((init as RequestInit).body as string).event ===
          'login_cta_clicked',
      );
      expect(navbarCalls).toHaveLength(0);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('exposes an accessible dialog (role, modal, labelled title)', () => {
    render(<LoginPrompt onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent(
      'Get more from SteamReveal',
    );
  });

  it('closes on Escape', () => {
    render(<LoginPrompt onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockOnClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('calls dontAskAgain and onClose on their buttons', () => {
    render(<LoginPrompt onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    fireEvent.click(screen.getByText("Don't ask again"));
    expect(mockDontAskAgain).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});

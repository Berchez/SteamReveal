import { render, screen } from '@testing-library/react';
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

const BOT_PROFILE = 'https://steamcommunity.com/profiles/76561199000000001';

describe('SiteNavSignIn', () => {
  it('preserves the current page as the post-login destination', () => {
    render(<SiteNavSignIn botProfileUrl={BOT_PROFILE} />);

    expect(
      screen.getByRole('link', { name: 'watchNavSignIn' }),
    ).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fpt%2Fplayer%2Fplayer-c',
    );
  });

  it('falls back to the locale home without a pathname', () => {
    mockUsePathname.mockReturnValueOnce(null);
    render(<SiteNavSignIn botProfileUrl={BOT_PROFILE} />);

    expect(
      screen.getByRole('link', { name: 'watchNavSignIn' }),
    ).toHaveAttribute('href', '/api/auth/steam/login?next=%2Fpt%2F');
  });

  it('renders the add-the-bot chip first (single-state step 1) when the URL is known', () => {
    render(<SiteNavSignIn botProfileUrl={BOT_PROFILE} />);

    const chip = screen.getByRole('link', { name: /watchSignInAddBot/ });
    expect(chip).toHaveAttribute('href', BOT_PROFILE);
    // Opens Steam in a new tab: the user adds the friend and comes back.
    expect(chip).toHaveAttribute('target', '_blank');
    expect(chip).toHaveAttribute('rel', 'noreferrer');
  });

  it('hides the bot chip when the server env lacks a valid bot id (degraded cluster)', () => {
    render(<SiteNavSignIn botProfileUrl={null} />);

    expect(
      screen.queryByRole('link', { name: /watchSignInAddBot/ }),
    ).not.toBeInTheDocument();
    // The sign-in pill survives — global chrome never breaks over env.
    expect(
      screen.getByRole('link', { name: 'watchNavSignIn' }),
    ).toBeInTheDocument();
  });
});

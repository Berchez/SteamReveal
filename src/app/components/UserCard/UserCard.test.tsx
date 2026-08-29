import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import UserCard from './UserCard';
import { UserSummary } from 'steamapi';
import useGamersClubName from '../UserQuickLinks/useGamersClubName';
import { getLocationDetails } from '@/app/templates/Home/hooks/search/homeUtils';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

jest.mock('../../templates/Home/hooks/search/homeUtils', () => ({
  getLocationDetails: jest.fn(),
}));

jest.mock('../UserQuickLinks/useGamersClubName', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  useSearchParams: jest.fn(),
}));

// The real `@/navigation` Link is next-intl locale-aware and expects a
// surrounding provider we don't want to set up for these tests — a plain
// anchor is enough to assert the computed `href`.
// IMPORTANT: mocking '@/navigation' directly does NOT intercept the real
// import inside UserCard.tsx in this project — the alias gets rewritten to
// its real resolved path before Jest ever sees the alias string, so a mock
// registered under either the alias or a guessed relative path may not
// match. `@/navigation.ts` itself is built on top of next-intl's
// `createNavigation` (from the plain, unaliased `next-intl/navigation`
// package) — mocking that package instead guarantees interception
// regardless of where `@/navigation.ts` actually lives on disk.
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children, ...rest }: any) => (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
    redirect: jest.fn(),
    usePathname: jest.fn(),
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

global.fetch = jest.fn();

describe('UserCard Component', () => {
  const mockTranslator = (key: string) => {
    const translations: { [key: string]: string } = {
      nickname: 'Nickname',
      realName: 'Real Name',
      probability: 'Probability',
      url: 'Url',
      reliability: 'Reliability',
      searchFriend: 'Search friend',
    };
    return translations[key];
  };

  const mockFriend: UserSummary = {
    steamID: '12345',
    avatar: {
      small: 'https://example.com/avatar-small.png',
      medium: 'https://example.com/avatar-medium.png',
      large: 'https://example.com/avatar-large.png',
      hash: 'https://example.com/avatar-hash.png',
    },
    nickname: 'User123',
    realName: 'John Doe',
    countryCode: 'us',
    stateCode: 'CA',
    cityID: '123',
    url: 'https://steamcommunity.com/id/user123',
    visible: true,
    personaState: 1,
    personaStateFlags: 0,
    lastLogOffAt: new Date(),
    createdAt: new Date(),
    primaryGroupID: '12345',
    allowsComments: true,
    profileURL: 'https://steamcommunity.com/id/user123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useTranslations as jest.Mock).mockReturnValue(mockTranslator);
    (getLocationDetails as jest.Mock).mockResolvedValue({
      city: { name: 'San Francisco' },
      state: { name: 'California' },
      country: { name: 'United States' },
    });
    (useGamersClubName as jest.Mock).mockReturnValue({
      name: null,
      isLoading: false,
      error: null,
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    // Default for the target-user tests below, which don't care about the
    // search-friend link — the Case 6 describe block overrides this per test.
    (useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams(''));
  });

  it('renders the user avatar, nickname, and real name', async () => {
    await act(async () => {
      render(<UserCard friend={mockFriend} itsTargetUser={true} />);
    });

    expect(
      screen.getByAltText(/Avatar of the user User123/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nickname: User123/i)).toBeInTheDocument();
    expect(screen.getByText(/Real Name: John Doe/i)).toBeInTheDocument();
  });

  it('displays location details after fetching', async () => {
    await act(async () => {
      render(<UserCard friend={mockFriend} itsTargetUser={true} />);
    });

    expect(
      screen.getByAltText(/country flag \(us\) of the user User123/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText(/San Francisco, California, United States/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the probability, count, and URL if provided', async () => {
    await act(async () => {
      render(
        <UserCard
          friend={mockFriend}
          itsTargetUser={true}
          probability={85}
          count={10}
        />,
      );
    });

    expect(screen.getByText(/Probability: 85.00%/i)).toBeInTheDocument();
    expect(screen.getByText(/Reliability: 10/i)).toBeInTheDocument();
    expect(screen.getByText(/Url:/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: /https:\/\/steamcommunity.com\/id\/user123/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders QuickLinks when itsTargetUser is true', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        faceitLink: 'https://www.faceit.com/en/players/test-player',
      }),
    });

    await act(async () => {
      render(<UserCard friend={mockFriend} itsTargetUser={true} />);
    });

    expect(
      screen.getByRole('link', { name: 'SteamID.uk' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'GamersClub' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Faceit' })).toBeInTheDocument();
    });

    const faceitLink = screen.getByRole('link', {
      name: 'Faceit',
    }) as HTMLAnchorElement;
    await waitFor(() => {
      expect(faceitLink).toHaveAttribute(
        'href',
        'https://www.faceit.com/en/players/test-player',
      );
    });
  });

  // ---------------------------------------------------------------------
  // Case 6: "search friend" link — query param preservation + safe fallback
  // ---------------------------------------------------------------------
  //
  // NOTE: the link's accessible name is "Search friend {nickname}" (the
  // aria-label interpolates friend.nickname so screen readers can tell
  // multiple friend cards' links apart). We match with a regex here instead
  // of the literal translated string, so these tests keep passing if the
  // mock nickname or the exact label format changes later — we only care
  // that it's *the* search-friend link, and assert behavior (href) rather
  // than the full label text.
  describe('search friend link (Case 6)', () => {
    it('strips navigation-owned params but preserves the rest of the query string', async () => {
      (useSearchParams as jest.Mock).mockReturnValue(
        new URLSearchParams('utm_source=campaign&player=old'),
      );

      await act(async () => {
        render(<UserCard friend={mockFriend} itsTargetUser={false} />);
      });

      const link = screen.getByRole('link', { name: /Search friend/i });
      expect(link).toHaveAttribute('href', '/player/12345?utm_source=campaign');
    });

    it('falls back to a clean path when there are no extra query params', async () => {
      (useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams(''));

      await act(async () => {
        render(<UserCard friend={mockFriend} itsTargetUser={false} />);
      });

      const link = screen.getByRole('link', { name: /Search friend/i });
      expect(link).toHaveAttribute('href', '/player/12345');
    });

    it('does not throw and falls back to the plain path when useSearchParams returns null', async () => {
      (useSearchParams as jest.Mock).mockReturnValue(null);

      await act(async () => {
        expect(() =>
          render(<UserCard friend={mockFriend} itsTargetUser={false} />),
        ).not.toThrow();
      });

      const link = screen.getByRole('link', { name: /Search friend/i });
      expect(link).toHaveAttribute('href', '/player/12345');
    });

    it('does not render the search-friend link for the target user card', async () => {
      (useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams(''));

      await act(async () => {
        render(<UserCard friend={mockFriend} itsTargetUser />);
      });

      expect(
        screen.queryByRole('link', { name: /Search friend/i }),
      ).not.toBeInTheDocument();
    });
  });
});

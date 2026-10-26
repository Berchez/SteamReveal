import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import SiteNav from './SiteNav';

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: { nickname?: string }) =>
    key === 'watchAvatarAlt'
      ? `avatar of ${values?.nickname ?? ''}`
      : key,
}));

jest.mock('./NavLogo', () => ({
  __esModule: true,
  default: () => <div data-testid="nav-logo-stub" />,
}));

jest.mock('@/app/components/LanguageSwitcher', () => ({
  __esModule: true,
  default: () => <div data-testid="language-switcher-stub" />,
}));

jest.mock('./SiteNavSignIn', () => ({
  __esModule: true,
  default: ({ botOnline }: { botOnline: boolean }) => (
    <div data-testid="sign-in-stub">{String(botOnline)}</div>
  ),
}));

jest.mock('@/app/components/WatchInbox', () => ({
  __esModule: true,
  default: ({ steamId }: { steamId: string }) => (
    <div data-testid="watch-inbox-stub">{steamId}</div>
  ),
}));

jest.mock('./SiteNavMenu', () => ({
  __esModule: true,
  default: ({
    steamId,
    avatarAlt,
  }: {
    steamId: string;
    avatarAlt: string;
  }) => (
    <div data-testid="site-nav-menu-stub" data-avatar-alt={avatarAlt}>
      {steamId}
    </div>
  ),
}));

const STEAM = '76561198000000001';

describe('SiteNav', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('paints the skeleton while the private state request is in flight', () => {
    global.fetch = jest.fn(() => new Promise(() => undefined)) as never;

    render(<SiteNav />);

    expect(screen.getByTestId('site-nav')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('language-switcher-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-stub')).not.toBeInTheDocument();
  });

  it('renders the logged-out cluster from the API response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ steamId: null, botOnline: true }),
    })) as never;

    render(<SiteNav />);

    await waitFor(() =>
      expect(screen.getByTestId('sign-in-stub')).toHaveTextContent('true'),
    );
    expect(screen.queryByTestId('site-nav-menu-stub')).not.toBeInTheDocument();
  });

  it('renders the logged-in cluster and avatar label', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        steamId: STEAM,
        nickname: 'AvatarUser',
        avatarUrl: null,
        initialWatch: null,
      }),
    })) as never;

    render(<SiteNav />);

    await waitFor(() =>
      expect(screen.getByTestId('site-nav-menu-stub')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('watch-inbox-stub')).toHaveTextContent(STEAM);
    expect(screen.getByTestId('site-nav-menu-stub')).toHaveAttribute(
      'data-avatar-alt',
      'avatar of AvatarUser',
    );
  });

  it('degrades to logged-out when the private state request fails', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as never;

    render(<SiteNav />);

    await waitFor(() =>
      expect(screen.getByTestId('sign-in-stub')).toHaveTextContent('true'),
    );
    expect(screen.queryByTestId('site-nav-menu-stub')).not.toBeInTheDocument();
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SessionHintContext } from '@/app/templates/Home/context';
import {
  resetGcServiceStatus,
  setGcServiceStatus,
} from '@/app/templates/Home/shared/analytics/gcServiceStatus';

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

let uuidCounter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {
  configurable: true,
  value: () => `uuid-${(uuidCounter += 1)}`,
});

// Required after the crypto stub above: FriendsSection builds its skeleton
// pool with crypto.randomUUID at module scope, which jsdom lacks.
const { default: FriendsSection } = require('./FriendsSection');

jest.mock('@/app/components/UserCard', () => ({
  __esModule: true,
  default: ({
    friend,
    allowGcName,
  }: {
    friend: { steamID: string };
    allowGcName?: boolean;
  }) => (
    <div
      data-testid={`friend-card-${friend.steamID}`}
      data-allow-gc={String(allowGcName)}
    />
  ),
}));

jest.mock('@/app/components/UserCard/UserCardSkeleton', () => ({
  __esModule: true,
  default: () => <div data-testid="friend-skeleton" />,
}));

jest.mock('./GamersClubBanner', () => ({
  __esModule: true,
  default: ({ lockedCount }: { lockedCount: number }) => (
    <div data-testid="gc-banner" data-locked-count={lockedCount} />
  ),
}));

const friend = (steamID: string) =>
  ({
    friend: { steamID },
    count: 1,
    probability: 50,
  }) as never;

describe('FriendsSection — private/empty empty-states', () => {
  it('renders skeletons while the list is unresolved', () => {
    render(<FriendsSection closeFriendsJson={undefined} />);
    expect(screen.getAllByTestId('friend-skeleton').length).toBeGreaterThan(0);
    expect(
      screen.queryByTestId('friends-private-empty-state'),
    ).not.toBeInTheDocument();
  });

  it('renders friend cards for a public list', () => {
    render(
      <FriendsSection
        closeFriendsJson={[friend('76561198000000001')]}
        friendsVisibility="public"
      />,
    );
    expect(
      screen.getByTestId('friend-card-76561198000000001'),
    ).toBeInTheDocument();
  });

  it('renders the private empty-state for a private list', () => {
    render(<FriendsSection closeFriendsJson={[]} friendsVisibility="private" />);
    expect(
      screen.getByTestId('friends-private-empty-state'),
    ).toBeInTheDocument();
    expect(screen.getByText('friendsPrivateTitle')).toBeInTheDocument();
    expect(screen.getByText('friendsPrivateStillWorks')).toBeInTheDocument();
  });

  it('renders the genuinely-empty empty-state for an empty public list', () => {
    render(<FriendsSection closeFriendsJson={[]} friendsVisibility="empty" />);
    expect(
      screen.getByTestId('friends-empty-empty-state'),
    ).toBeInTheDocument();
    expect(screen.getByText('friendsEmptyTitle')).toBeInTheDocument();
    expect(
      screen.queryByTestId('friends-private-empty-state'),
    ).not.toBeInTheDocument();
  });

  it('renders no empty-state claim for an empty list with unknown visibility (failed request)', () => {
    render(<FriendsSection closeFriendsJson={[]} />);
    expect(
      screen.queryByTestId('friends-private-empty-state'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('friends-empty-empty-state'),
    ).not.toBeInTheDocument();
    // Header still renders — bare, with no claim either way.
    expect(screen.getByText('friendsIRL')).toBeInTheDocument();
  });
});

describe('FriendsSection — logged-out GC Name gate', () => {
  it('keeps the first two cards unlocked, locks the rest, and inserts one banner between card 2 and 3', () => {
    const ids = ['01', '02', '03', '04'].map(
      (suffix) => `765611980000000${suffix}`,
    );

    render(
      <FriendsSection
        closeFriendsJson={ids.map((id) => friend(id))}
        friendsVisibility="public"
      />,
    );

    expect(screen.getByTestId(`friend-card-${ids[0]}`)).toHaveAttribute(
      'data-allow-gc',
      'true',
    );
    expect(screen.getByTestId(`friend-card-${ids[1]}`)).toHaveAttribute(
      'data-allow-gc',
      'true',
    );
    expect(screen.getByTestId(`friend-card-${ids[2]}`)).toHaveAttribute(
      'data-allow-gc',
      'false',
    );
    expect(screen.getByTestId(`friend-card-${ids[3]}`)).toHaveAttribute(
      'data-allow-gc',
      'false',
    );

    const banner = screen.getByTestId('gc-banner');
    expect(banner).toHaveAttribute('data-locked-count', '2');

    const html = screen.getByTestId('friends-section').innerHTML;
    expect(html.indexOf(`friend-card-${ids[1]}`)).toBeLessThan(
      html.indexOf('gc-banner'),
    );
    expect(html.indexOf('gc-banner')).toBeLessThan(
      html.indexOf(`friend-card-${ids[2]}`),
    );
  });

  it('does not gate cards or render the banner for logged-in visitors', () => {
    const ids = ['01', '02', '03'].map(
      (suffix) => `765611980000000${suffix}`,
    );

    render(
      <SessionHintContext.Provider value={true}>
        <FriendsSection
          closeFriendsJson={ids.map((id) => friend(id))}
          friendsVisibility="public"
        />
      </SessionHintContext.Provider>,
    );

    ids.forEach((id) => {
      expect(screen.getByTestId(`friend-card-${id}`)).toHaveAttribute(
        'data-allow-gc',
        'true',
      );
    });
    expect(screen.queryByTestId('gc-banner')).not.toBeInTheDocument();
  });

  it('does not render the banner for a list of two friends', () => {
    const ids = ['01', '02'].map((suffix) => `765611980000000${suffix}`);

    render(
      <FriendsSection
        closeFriendsJson={ids.map((id) => friend(id))}
        friendsVisibility="public"
      />,
    );

    expect(screen.queryByTestId('gc-banner')).not.toBeInTheDocument();
  });
});

describe('FriendsSection — GC Name upsell while the scraper is offline', () => {
  afterEach(() => {
    resetGcServiceStatus();
  });

  it('hides the upsell banner while the GC scraper is unavailable', () => {
    const ids = ['01', '02', '03'].map((suffix) => `765611980000000${suffix}`);
    setGcServiceStatus('unavailable');

    render(
      <FriendsSection
        closeFriendsJson={ids.map((id) => friend(id))}
        friendsVisibility="public"
      />,
    );

    // The banner sells a feature that cannot work while the scraper is
    // down — it must not be rendered in that state.
    expect(screen.queryByTestId('gc-banner')).not.toBeInTheDocument();
    // The cards keep their gate (first two unlocked, rest locked).
    expect(screen.getByTestId(`friend-card-${ids[0]}`)).toHaveAttribute(
      'data-allow-gc',
      'true',
    );
    expect(screen.getByTestId(`friend-card-${ids[2]}`)).toHaveAttribute(
      'data-allow-gc',
      'false',
    );
  });

  it('keeps the upsell banner while the GC scraper is available', () => {
    const ids = ['01', '02', '03'].map((suffix) => `765611980000000${suffix}`);
    setGcServiceStatus('available');

    render(
      <FriendsSection
        closeFriendsJson={ids.map((id) => friend(id))}
        friendsVisibility="public"
      />,
    );

    expect(screen.getByTestId('gc-banner')).toBeInTheDocument();
  });
});

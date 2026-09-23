import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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
  default: ({ friend }: { friend: { steamID: string } }) => (
    <div data-testid={`friend-card-${friend.steamID}`} />
  ),
}));

jest.mock('@/app/components/UserCard/UserCardSkeleton', () => ({
  __esModule: true,
  default: () => <div data-testid="friend-skeleton" />,
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

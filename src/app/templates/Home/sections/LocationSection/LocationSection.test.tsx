import '@testing-library/jest-dom';

import React from 'react';

import { render } from '@testing-library/react';

import { NextIntlClientProvider } from 'next-intl';

import { UserSummary } from 'steamapi';

const mockRandomUUID = jest
  .fn()
  .mockReturnValueOnce('uuid-1')
  .mockReturnValueOnce('uuid-2')
  .mockReturnValueOnce('uuid-3');

Object.defineProperty(globalThis.crypto, 'randomUUID', {
  configurable: true,
  value: mockRandomUUID,
});

const { default: LocationSection } = require('./LocationSection');

const messages = {
  Index: { userPossibleLocation: 'User possible location' },
  LocationCard: {
    providedByUser: 'Provided by user:',
    noLocationEstimate: 'Could not estimate a location.',
    triangulationUnavailable: 'Triangulation unavailable notice',
  },
};

const renderWithIntl = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('LocationSection', () => {
  it('renders the heading without a skeleton once nothing is pending (e.g. an invalid player)', () => {
    // Nothing is loading and no location resolved: the section settles on
    // its heading only. It used to keep an eternal skeleton here, which the
    // e2e suite catches on the invalid-player route (a skeleton spinning
    // forever is a worse failure than a short section).
    const { getByText, container } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={undefined}
      />,
    );

    expect(getByText('User possible location')).toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="location-skeleton-map"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="location-skeleton-provided"]'),
    ).not.toBeInTheDocument();
  });

  it('renders the skeleton (not null) while loading, even once possibleLocationJson is the only thing still missing', () => {
    // Regression test for using the WRONG loading flag: this used to be
    // fed isLoading.friendsCards, which flips false as soon as
    // getCloseFriendsJson resolves — before getPossibleLocation (which
    // produces possibleLocationJson) even starts. This test asserts the
    // section stays mounted for as long as ITS OWN loading flag says so,
    // regardless of what stage friends/other data are at.
    const { getByText, container } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={{
          profileInfo: { steamID: '123' } as UserSummary,
          targetLocationInfo: {},
        }}
        isLoadingLocation
      />,
    );

    expect(getByText('User possible location')).toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="location-skeleton-map"]'),
    ).toBeInTheDocument();
  });

  it("gives the skeleton a fresh key per player so a new player never inherits the previous one's locked shape", () => {
    const { rerender, container } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={{
          profileInfo: { steamID: 'player-a' } as UserSummary,
          targetLocationInfo: {},
        }}
        isLoadingLocation
      />,
    );

    expect(
      container.querySelector('[data-testid="location-skeleton-provided"]'),
    ).not.toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LocationSection
          possibleLocationJson={undefined}
          targetInfoJson={{
            profileInfo: { steamID: 'player-b' } as UserSummary,
            targetLocationInfo: {
              city: { id: 1, name: 'Sao Paulo' },
              state: { code: 'SP', name: 'Sao Paulo' },
              country: { code: 'BR', name: 'Brazil' },
            },
          }}
          isLoadingLocation
        />
      </NextIntlClientProvider>,
    );

    // Different steamID -> different `key` -> fresh skeleton instance ->
    // player B's already-resolved data shows up immediately, proving this
    // is NOT the same locked instance that player A used.
    expect(
      container.querySelector('[data-testid="location-skeleton-provided"]'),
    ).toBeInTheDocument();
  });

  it('shows the triangulation notice for private lists already over the skeleton (no CLS on resolve)', () => {
    // CLS: friendsVisibility is known before possibleLocationJson resolves,
    // so the identical notice renders in both branches — the skeleton→card
    // swap then adds/removes nothing.
    const skeletonRender = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={{
          profileInfo: { steamID: 'player-private' } as UserSummary,
          targetLocationInfo: {
            country: { code: 'CN', name: 'China' },
          },
        }}
        friendsVisibility="private"
        isLoadingLocation
      />,
    );
    expect(
      skeletonRender.queryByTestId('location-triangulation-notice'),
    ).toBeInTheDocument();
    skeletonRender.unmount();
  });

  it('hides the triangulation notice when the profile declared no location', () => {
    // The notice claims "showing only the self-declared location" — with
    // nothing declared the card renders the no-estimate empty state and
    // the notice would be wrong, so it must not render in either branch.
    const targetInfoJson = {
      profileInfo: { steamID: 'player-private' } as UserSummary,
      targetLocationInfo: {},
    };
    const { queryByTestId, rerender } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={targetInfoJson}
        friendsVisibility="private"
      />,
    );
    expect(
      queryByTestId('location-triangulation-notice'),
    ).not.toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LocationSection
          possibleLocationJson={[]}
          targetInfoJson={targetInfoJson}
          friendsVisibility="private"
        />
      </NextIntlClientProvider>,
    );
    expect(
      queryByTestId('location-triangulation-notice'),
    ).not.toBeInTheDocument();
    expect(queryByTestId('location-empty-state')).toBeInTheDocument();
  });

  it('shows the triangulation notice for private lists once locations resolve', () => {
    const targetInfoJson = {
      profileInfo: { steamID: 'player-private' } as UserSummary,
      targetLocationInfo: {
        country: { code: 'CN', name: 'China' },
      },
    };
    const { queryByTestId, rerender } = renderWithIntl(
      <LocationSection
        possibleLocationJson={[]}
        targetInfoJson={targetInfoJson}
        friendsVisibility="private"
      />,
    );

    expect(queryByTestId('location-triangulation-notice')).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LocationSection
          possibleLocationJson={[]}
          targetInfoJson={targetInfoJson}
          friendsVisibility="public"
        />
      </NextIntlClientProvider>,
    );

    expect(
      queryByTestId('location-triangulation-notice'),
    ).not.toBeInTheDocument();
  });
});

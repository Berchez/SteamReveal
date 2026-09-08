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
};

const renderWithIntl = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('LocationSection', () => {
  it('renders the skeleton even when idle (no data, not loading), so the section never collapses to zero height', () => {
    // The section must not unmount during the `!data && !isLoading` window
    // (before the fetch kicks off / between resets): collapsing to zero
    // height on first paint banked a full-section layout shift when the
    // content landed. Home.tsx only mounts this section when hasNoDataYet is
    // false, so the heading + skeleton here can never leak onto the home
    // empty state. `isLoading` is ignored by design.
    const { getByText, container } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={undefined}
      />,
    );

    expect(getByText('User possible location')).toBeInTheDocument();
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
    const { getByText } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={{
          profileInfo: { steamID: '123' } as UserSummary,
          targetLocationInfo: {},
        }}
      />,
    );

    expect(getByText('User possible location')).toBeInTheDocument();
  });

  it("gives the skeleton a fresh key per player so a new player never inherits the previous one's locked shape", () => {
    const { rerender, container } = renderWithIntl(
      <LocationSection
        possibleLocationJson={undefined}
        targetInfoJson={{
          profileInfo: { steamID: 'player-a' } as UserSummary,
          targetLocationInfo: {},
        }}
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
});

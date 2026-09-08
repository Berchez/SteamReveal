import '@testing-library/jest-dom';

import React from 'react';

import { render } from '@testing-library/react';

const mockRandomUUID = jest.fn(() => 'test-uuid');

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    randomUUID: mockRandomUUID,
  },
});

const LocationCardSkeleton = require('./LocationCardSkeleton').default;

describe('LocationCardSkeleton', () => {
  it('does not render the "provided by user" line or a map placeholder when providedLocation starts empty', () => {
    const { queryByTestId } = render(
      <LocationCardSkeleton providedLocation={{}} />,
    );

    expect(queryByTestId('location-skeleton-provided')).not.toBeInTheDocument();

    expect(queryByTestId('location-skeleton-map')).not.toBeInTheDocument();
  });

  it('keeps its initial (empty) shape when providedLocation resolves later on the SAME instance', () => {
    // Regression test for the seeded-profile CLS bug: getSeededUserInfoJson
    // resolves targetLocationInfo asynchronously while this skeleton is
    // still mounted. Re-rendering with new props (no key change) must NOT
    // grow the skeleton.
    const { rerender, queryByTestId } = render(
      <LocationCardSkeleton providedLocation={{}} />,
    );

    rerender(
      <LocationCardSkeleton
        providedLocation={{
          cityName: 'Sao Paulo',
          stateName: 'SP',
          countryName: 'Brazil',
          countryCode: 'BR',
        }}
      />,
    );

    expect(queryByTestId('location-skeleton-provided')).not.toBeInTheDocument();

    expect(queryByTestId('location-skeleton-map')).not.toBeInTheDocument();
  });

  it('reflects providedLocation immediately when it is already resolved on first render (non-seeded path)', () => {
    const { queryByTestId } = render(
      <LocationCardSkeleton
        providedLocation={{
          cityName: 'Sao Paulo',
          stateName: 'SP',
          countryName: 'Brazil',
          countryCode: 'BR',
        }}
      />,
    );

    expect(queryByTestId('location-skeleton-provided')).toBeInTheDocument();

    expect(queryByTestId('location-skeleton-map')).toBeInTheDocument();
  });

  it('does not pop a late-arriving cityName into the already-visible "provided by user" line', () => {
    // Partial enrichment on the SAME instance: stateName+countryCode were
    // present on first render but cityName arrived a moment later. The
    // displayed fields must come from the frozen first-render snapshot, not
    // the live props — otherwise a new paragraph appears mid-flight.
    const { rerender, queryByText, queryByTestId } = render(
      <LocationCardSkeleton
        providedLocation={{
          stateName: 'SP',
          countryName: 'Brazil',
          countryCode: 'BR',
        }}
      />,
    );

    expect(queryByTestId('location-skeleton-provided')).toBeInTheDocument();
    expect(queryByText('Sao Paulo,')).not.toBeInTheDocument();

    rerender(
      <LocationCardSkeleton
        providedLocation={{
          cityName: 'Sao Paulo',
          stateName: 'SP',
          countryName: 'Brazil',
          countryCode: 'BR',
        }}
      />,
    );

    expect(queryByText('Sao Paulo,')).not.toBeInTheDocument();
  });
});

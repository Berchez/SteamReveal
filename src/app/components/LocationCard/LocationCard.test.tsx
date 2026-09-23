import { render, screen } from '@testing-library/react';
import LocationCard from './LocationCard';
import '@testing-library/jest-dom';
import { useTranslations } from 'next-intl';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

describe('LocationCard component', () => {
  const mockUseTranslations = useTranslations as jest.Mock;

  beforeEach(() => {
    mockUseTranslations.mockImplementation(() => (key: string) => key);
  });

  it('renders with providedLocation but no possibleLocations', () => {
    const providedLocation = {
      cityName: 'São Paulo',
      stateName: 'São Paulo',
      countryName: 'Brazil',
      countryCode: 'BR',
    };

    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.getByText(/providedByUser/i)).toBeInTheDocument();
    expect(screen.getAllByText(/São Paulo/i)).toHaveLength(2);
    expect(screen.getByText(/Brazil/i)).toBeInTheDocument();
    expect(screen.getByAltText(/BR's flag/i)).toBeInTheDocument();
  });

  it('renders with multiple possibleLocations', () => {
    const providedLocation = {};
    const possibleLocations = [
      {
        location: {
          cityName: 'New York',
          stateName: 'New York',
          countryName: 'USA',
          countryCode: 'US',
        },
        probability: 85.5,
        count: 150,
      },
      {
        location: {
          cityName: 'Los Angeles',
          stateName: 'California',
          countryName: 'USA',
          countryCode: 'US',
        },
        probability: 65.2,
        count: 100,
      },
    ];

    render(
      <LocationCard
        providedLocation={providedLocation}
        possibleLocations={possibleLocations}
      />,
    );

    expect(screen.getAllByText(/USA/i)).toHaveLength(2);

    expect(screen.getByText(/New York,/i)).toBeInTheDocument();
    expect(screen.getByText(/85.50%/i)).toBeInTheDocument();
    expect(screen.getByText(/\(150\)/i)).toBeInTheDocument();

    expect(screen.getByText(/Los Angeles,/i)).toBeInTheDocument();
    expect(screen.getByText(/California,/i)).toBeInTheDocument();
    expect(screen.getByText(/65.20%/i)).toBeInTheDocument();
    expect(screen.getByText(/(100)/i)).toBeInTheDocument();
  });

  it('renders partial providedLocation details when only some fields are present', () => {
    const providedLocation = {
      cityName: 'São Paulo',
      countryName: 'Brazil',
    };

    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.getByText(/providedByUser/i)).toBeInTheDocument();
    expect(screen.getByText('São Paulo,')).toBeInTheDocument();
    expect(screen.getByText('Brazil')).toBeInTheDocument();
    expect(screen.queryByText('noLocationEstimate')).not.toBeInTheDocument();
  });

  it('omits the header bottom margin when nothing follows the provided block', () => {
    // A lone "Provided by user" (no triangulation, no map) must not carry
    // a dangling mb-3 into the card's bottom padding.
    render(
      <LocationCard
        providedLocation={{ countryName: 'China', countryCode: 'CN' }}
      />,
    );

    const header = screen.getByText(/providedByUser/i).closest('div');
    expect(header).not.toHaveClass('mb-3');
  });

  it('keeps the header bottom margin when a city-level map follows (no triangulation)', () => {
    // City-declared location without triangulation still renders the map
    // below the header, so mb-3 stays.
    render(
      <LocationCard
        providedLocation={{
          cityName: 'Beijing',
          countryName: 'China',
          countryCode: 'CN',
        }}
      />,
    );

    const header = screen.getByText(/providedByUser/i).closest('div');
    expect(header).toHaveClass('mb-3');
  });

  it('keeps the header bottom margin when triangulation rows follow', () => {
    render(
      <LocationCard
        providedLocation={{ countryName: 'China', countryCode: 'CN' }}
        possibleLocations={[
          {
            location: {
              cityName: 'Beijing',
              countryName: 'China',
              countryCode: 'CN',
            },
            probability: 85.5,
            count: 150,
          },
        ]}
      />,
    );

    const header = screen.getByText(/providedByUser/i).closest('div');
    expect(header).toHaveClass('mb-3');
  });

  it('renders a country-only provided location instead of the no-estimate message', () => {
    // Real case: a profile declaring only a country (e.g. China, no
    // state/city, no friends to triangulate from) must show what the user
    // declared — never "could not estimate".
    const providedLocation = {
      countryName: 'China',
      countryCode: 'CN',
    };

    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.getByText(/providedByUser/i)).toBeInTheDocument();
    expect(screen.getByText('China')).toBeInTheDocument();
    expect(screen.getByAltText(/CN's flag/i)).toBeInTheDocument();
    expect(screen.queryByText('noLocationEstimate')).not.toBeInTheDocument();
  });

  it('does not render possibleLocations with count 0 or probability 0', () => {
    const providedLocation = {};
    const possibleLocations = [
      {
        location: {
          cityName: 'New York',
          stateName: 'New York',
          countryName: 'USA',
          countryCode: 'US',
        },
        probability: 85.5,
        count: 150,
      },
      {
        location: {
          cityName: 'Joao Pessoa',
          stateName: 'Paraiba',
          countryName: 'Brazil',
          countryCode: 'BR',
        },
        probability: 0,
        count: 0,
      },
    ];

    render(
      <LocationCard
        providedLocation={providedLocation}
        possibleLocations={possibleLocations}
      />,
    );

    expect(screen.getByText(/New York,/i)).toBeInTheDocument();
    expect(screen.getByText(/85.50%/i)).toBeInTheDocument();
    expect(screen.queryByText(/Joao Pessoa,/i)).not.toBeInTheDocument();
  });

  it('renders fallback when no providedLocation or possibleLocations', () => {
    const providedLocation = {};
    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.queryByText('providedByUser')).not.toBeInTheDocument();
    expect(screen.queryByText('New York,')).not.toBeInTheDocument();
  });

  it('renders the no-estimate message when there is nothing to show', () => {
    render(<LocationCard providedLocation={{}} possibleLocations={[]} />);

    expect(screen.getByText('noLocationEstimate')).toBeInTheDocument();
  });

  it('renders the empty state in the gray-glass card style (matching FriendsSection)', () => {
    render(<LocationCard providedLocation={{}} possibleLocations={[]} />);

    const emptyState = screen.getByTestId('location-empty-state');
    expect(emptyState).toHaveClass('bg-gray-800/60');
    expect(emptyState).not.toHaveClass('bg-purple-900');
  });

  it('renders the no-estimate message when every candidate is a legacy zero row', () => {
    const possibleLocations = [
      {
        location: {
          cityName: 'Joao Pessoa',
          stateName: 'Paraiba',
          countryName: 'Brazil',
          countryCode: 'BR',
        },
        probability: 0,
        count: 0,
      },
    ];

    render(
      <LocationCard providedLocation={{}} possibleLocations={possibleLocations} />,
    );

    expect(screen.queryByText(/Joao Pessoa,/i)).not.toBeInTheDocument();
    expect(screen.getByText('noLocationEstimate')).toBeInTheDocument();
  });

  it('does not render the no-estimate message when triangulation exists', () => {
    const possibleLocations = [
      {
        location: {
          cityName: 'New York',
          stateName: 'New York',
          countryName: 'USA',
          countryCode: 'US',
        },
        probability: 85.5,
        count: 150,
      },
    ];

    render(
      <LocationCard providedLocation={{}} possibleLocations={possibleLocations} />,
    );

    expect(screen.getByText(/New York,/i)).toBeInTheDocument();
    expect(screen.queryByText('noLocationEstimate')).not.toBeInTheDocument();
  });

  it('does not render the no-estimate message when the user provided a location', () => {
    const providedLocation = {
      cityName: 'São Paulo',
      stateName: 'São Paulo',
      countryName: 'Brazil',
      countryCode: 'BR',
    };

    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.getByText(/providedByUser/i)).toBeInTheDocument();
    expect(screen.queryByText('noLocationEstimate')).not.toBeInTheDocument();
  });
});

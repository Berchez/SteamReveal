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

  it('does not render providedLocation details if countryCode or stateName is missing', () => {
    const providedLocation = {
      cityName: 'São Paulo',
      countryName: 'Brazil',
    };

    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.queryByText('São Paulo,')).not.toBeInTheDocument();
    expect(screen.queryByText('Brazil')).not.toBeInTheDocument();
  });

  it('renders fallback when no providedLocation or possibleLocations', () => {
    const providedLocation = {};
    render(<LocationCard providedLocation={providedLocation} />);

    expect(screen.queryByText('providedByUser')).not.toBeInTheDocument();
    expect(screen.queryByText('New York,')).not.toBeInTheDocument();
  });
});

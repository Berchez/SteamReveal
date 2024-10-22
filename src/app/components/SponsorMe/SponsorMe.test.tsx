import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom'; // for the custom matchers like `toBeInTheDocument`
import SponsorMe from './SponsorMe';
import { useTranslations } from 'next-intl';

// Mock the `useTranslations` hook from `next-intl`
jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

describe('SponsorMe component', () => {
  const mockOnClose = jest.fn();
  const mockDontAskAgain = jest.fn();

  type TranslationKeys =
    | 'enjoying'
    | 'ifYouLikeIt'
    | 'giveStar'
    | 'dontAskAgain';

  beforeEach(() => {
    (useTranslations as jest.Mock).mockReturnValue((key: TranslationKeys) => {
      const translations: Record<TranslationKeys, string> = {
        enjoying: 'Are you enjoying this?',
        ifYouLikeIt:
          'If you like it, please consider leaving a star on our GitHub repository!',
        giveStar: 'Give us a star!',
        dontAskAgain: "Don't ask me again!",
      };
      return translations[key];
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the component with correct translations', () => {
    render(<SponsorMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    // Check that the translated texts are displayed
    expect(screen.getByText('Are you enjoying this?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'If you like it, please consider leaving a star on our GitHub repository!',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Give us a star!')).toBeInTheDocument();
    expect(screen.getByText("Don't ask me again!")).toBeInTheDocument();
  });

  it('calls the dontAskAgain function when "Dont ask me again" button is clicked', () => {
    render(<SponsorMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    const dontAskAgainButton = screen.getByText("Don't ask me again!");
    fireEvent.click(dontAskAgainButton);

    expect(mockDontAskAgain).toHaveBeenCalledTimes(1);
  });

  it('calls the onClose function when the close button is clicked', () => {
    render(<SponsorMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    const closeButton = screen.getByRole('button', { name: /×/ });
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('has a working GitHub link with correct attributes', () => {
    render(<SponsorMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    const githubLink = screen.getByText('Give us a star!').closest('a');

    expect(githubLink).toHaveAttribute(
      'href',
      'https://github.com/Berchez/SteamReveal',
    );
    expect(githubLink).toHaveAttribute('target', '_blank');
    expect(githubLink).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

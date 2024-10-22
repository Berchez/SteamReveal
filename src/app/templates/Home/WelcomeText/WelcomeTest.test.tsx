import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import WelcomeText from './WelcomeText';
import { useTranslations } from 'next-intl';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

describe('WelcomeText Template', () => {
  const mockTranslator = (key: string) => {
    const translations: { [key: string]: string } = {
      welcomeTo: 'Welcome to',
    };
    return translations[key];
  };

  beforeEach(() => {
    (useTranslations as jest.Mock).mockReturnValue(mockTranslator);
  });

  it('renders the welcome text correctly', () => {
    render(<WelcomeText />);

    expect(screen.getByText('Welcome to')).toBeInTheDocument();
  });

  it('renders the SteamReveal text and SVG', () => {
    render(<WelcomeText />);

    expect(screen.getByText('SteamReveal')).toBeInTheDocument();

    const svg = screen.getByRole('img', { hidden: true });
    expect(svg).toBeInTheDocument();
  });

  it('renders the borders and layout correctly', () => {
    render(<WelcomeText />);

    const borderDivs = document.querySelectorAll('.border-t-2.border-white');
    expect(borderDivs.length).toBe(3);
  });
});

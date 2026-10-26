import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRecordLoginCta = jest.fn();

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string, values?: unknown) => {
    if (namespace === 'Index' && key === 'gcUpsellDescription') {
      return `remaining ${(values as { count: number }).count}`;
    }
    return `${namespace}.${key}`;
  },
}));

jest.mock('@/navigation', () => ({
  usePathname: () => '/player/76561198000000001',
}));

jest.mock('@/app/templates/Home/shared/analytics/loginFunnel', () => ({
  recordLoginCta: () => mockRecordLoginCta(),
}));

import GamersClubBanner from './GamersClubBanner';

describe('GamersClubBanner', () => {
  beforeEach(() => {
    mockRecordLoginCta.mockClear();
  });

  it('shows the locked count and signs in back to the current player page', () => {
    render(<GamersClubBanner lockedCount={3} />);

    expect(screen.getByTestId('gc-name-upsell-banner')).toHaveAttribute(
      'data-locked-count',
      '3',
    );
    expect(screen.getByText('remaining 3')).toBeInTheDocument();

    const link = screen.getByRole('link', {
      name: 'Watch.watchLoginButton',
    });
    expect(link).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fen%2Fplayer%2F76561198000000001',
    );

    fireEvent.click(link);
    expect(mockRecordLoginCta).toHaveBeenCalledTimes(1);
  });
});

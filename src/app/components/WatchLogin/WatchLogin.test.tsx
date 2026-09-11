import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchLogin from './WatchLogin';

jest.mock('next-intl', () => ({
  useLocale: () => 'pt',
  useTranslations: () => (key: string) => key,
}));

describe('WatchLogin', () => {
  it('links to Steam OpenID preserving the watch context', () => {
    render(<WatchLogin authError={false} />);

    const link = screen.getByText('watchLoginButton').closest('a');
    expect(link).toHaveAttribute(
      'href',
      '/api/auth/steam/login?next=%2Fpt%2Fwatch',
    );
    expect(screen.queryByText('watchLoginError')).not.toBeInTheDocument();
  });

  it('surfaces callback failures instead of failing silently', () => {
    render(<WatchLogin authError />);

    expect(screen.getByRole('alert')).toHaveTextContent('watchLoginError');
    expect(screen.getByText('watchLoginButton')).toBeInTheDocument();
  });
});

import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import QueryToast from './QueryToast';

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const SEARCH = (value: string) => {
  Object.defineProperty(window, 'location', {
    value: {
      href: `http://localhost/en/${value}`,
      search: value,
    },
    writable: true,
    configurable: true,
  });
};

describe('QueryToast', () => {
  const replaceState = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState = replaceState;
  });

  it('renders nothing without a known param', async () => {
    SEARCH('');
    render(<QueryToast />);
    await act(async () => {});

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('shows the confirm success once and strips the param', async () => {
    SEARCH('?confirmed=ok');
    render(<QueryToast />);
    await act(async () => {});

    expect(screen.getByRole('status')).toHaveTextContent('watchConfirmOk');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('confirmed');
  });

  it('shows the confirm error variant and strips the param', async () => {
    SEARCH('?confirmed=error');
    render(<QueryToast />);
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('watchConfirmError');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed Steam callback leg and strips the param', async () => {
    SEARCH('?auth=error');
    render(<QueryToast />);
    await act(async () => {});

    expect(screen.getByRole('alert')).toHaveTextContent('watchLoginError');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('auth');
  });

  it('ignores unknown param values', async () => {
    SEARCH('?confirmed=maybe&auth=nope');
    render(<QueryToast />);
    await act(async () => {});

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

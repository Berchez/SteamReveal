import React, { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import QueryToast from './QueryToast';

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// NOTE: react-toastify is DELIBERATELY unmocked here (unlike
// QueryToast.test.tsx): this suite exercises the real ToastContainer
// subscription path — the exact machinery the setTimeout hack exists
// for. If the fire/container race regresses, the toast silently never
// renders and these fail.
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

describe('QueryToast under React.StrictMode (real ToastContainer)', () => {
  const replaceState = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState = replaceState;
    document.body.innerHTML = '';
  });

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });

  it('renders exactly one toast through StrictMode remount', async () => {
    SEARCH('?confirmed=ok');
    render(
      <StrictMode>
        <QueryToast />
      </StrictMode>,
    );
    await settle();

    // StrictMode mounts, unmounts, and remounts: the toast must survive
    // exactly once (neither eaten by the remount nor doubled).
    const toasts = document.querySelectorAll('.Toastify__toast');
    expect(toasts).toHaveLength(1);
    expect(screen.getByText('watchConfirmOk')).toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('confirmed');
  });

  it('renders the error variant through StrictMode remount', async () => {
    SEARCH('?auth=error');
    render(
      <StrictMode>
        <QueryToast />
      </StrictMode>,
    );
    await settle();

    expect(document.querySelectorAll('.Toastify__toast')).toHaveLength(1);
    expect(screen.getByText('watchLoginError')).toBeInTheDocument();
  });
});

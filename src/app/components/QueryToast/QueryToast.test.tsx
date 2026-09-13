import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom';

import QueryToast from './QueryToast';

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

jest.mock('react-toastify', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
  ToastContainer: () => null,
}));

import { toast } from 'react-toastify';

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
  const toastSuccess = toast.success as jest.Mock;
  const toastError = toast.error as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState = replaceState;
  });

  // The component defers the fire a macrotask past mount (see the
  // component comment), so flush with a real short wait, not just a
  // microtask.
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    });

  it('fires nothing without a known param', async () => {
    SEARCH('');
    render(<QueryToast />);
    await settle();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('fires success once and strips the param', async () => {
    SEARCH('?confirmed=ok');
    render(<QueryToast />);
    await settle();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('watchConfirmOk', {
      containerId: 'query-toast',
      role: 'status',
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('confirmed');
  });

  it('fires the confirm error variant and strips the param', async () => {
    SEARCH('?confirmed=error');
    render(<QueryToast />);
    await settle();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('watchConfirmError', {
      containerId: 'query-toast',
      role: 'alert',
    });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('fires the failed-callback error and strips the param', async () => {
    SEARCH('?auth=error');
    render(<QueryToast />);
    await settle();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('watchLoginError', {
      containerId: 'query-toast',
      role: 'alert',
    });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).not.toContain('auth');
  });

  it('ignores unknown param values', async () => {
    SEARCH('?confirmed=maybe&auth=nope');
    render(<QueryToast />);
    await settle();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

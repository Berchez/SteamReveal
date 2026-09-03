import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useTranslations } from 'next-intl';
import CheaterReport from './CheaterReport';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

// framer-motion's <motion.div> doesn't need to animate in jsdom — render it
// as a plain div so the branching logic in CheaterReport is what's tested.
jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

jest.mock('@/app/components/ReportBox', () => ({
  __esModule: true,
  default: () => <div data-testid="report-box">ReportBox</div>,
}));

const mockUseTranslations = useTranslations as jest.Mock;

describe('CheaterReport — error state + retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseTranslations.mockReturnValue((key: string) => key);
  });

  it('shows an error message with a retry button instead of an eternal skeleton when the fetch failed', () => {
    const onRetry = jest.fn();
    render(
      <CheaterReport
        cheaterData={undefined}
        cheaterError
        nickname="player4"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('reportFailedToLoad')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('report-box')).not.toBeInTheDocument();
  });

  it('fires onRetry when the retry button is clicked', () => {
    const onRetry = jest.fn();
    render(
      <CheaterReport
        cheaterData={undefined}
        cheaterError
        nickname="player4"
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the retry button for a cooldown window after a click, then re-enables it', () => {
    jest.useFakeTimers();
    try {
      const onRetry = jest.fn();
      render(
        <CheaterReport
          cheaterData={undefined}
          cheaterError
          nickname="player4"
          onRetry={onRetry}
        />,
      );

      const button = screen.getByRole('button', { name: 'retry' });
      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledTimes(1);

      // Immediately after a click the button is locked (spam loop choke) —
      // repeat clicks are no-ops.
      expect(button).toBeDisabled();
      expect((button as HTMLButtonElement).disabled).toBe(true);

      // After the 15s cooldown elapses, the button is usable again.
      act(() => {
        jest.advanceTimersByTime(15_000);
      });
      expect(button).toBeEnabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores repeat clicks inside the cooldown window (guard drains the spam loop)', () => {
    jest.useFakeTimers();
    try {
      const onRetry = jest.fn();
      render(
        <CheaterReport
          cheaterData={undefined}
          cheaterError
          nickname="player4"
          onRetry={onRetry}
        />,
      );

      const button = screen.getByRole('button', { name: 'retry' });
      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledTimes(1);

      // Several rapid clicks while disabled must not fire retries.
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(button).toBeDisabled();

      // Even a `fireEvent` on a disabled button is a no-op in the handler too
      // (defense in depth: `handleRetry` re-checks retryCooldownUntilRef).
      act(() => {
        jest.advanceTimersByTime(10_000); // 15s total elapsed -> re-enabled
      });
      expect(button).toBeEnabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders the data (and no error) once cheaterData is present even if cheaterError lingers', () => {
    render(
      <CheaterReport
        cheaterData={{ cheaterProbability: 0.42, featureObject: {} } as any}
        cheaterError
        nickname="player4"
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByTestId('report-box')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'retry' }),
    ).not.toBeInTheDocument();
  });
});

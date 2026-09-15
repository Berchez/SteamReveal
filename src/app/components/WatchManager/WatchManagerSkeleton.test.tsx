import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WatchManagerSkeleton from './WatchManagerSkeleton';

describe('WatchManagerSkeleton', () => {
  it('renders the placeholder with the same wrapper as the real states', () => {
    const { container } = render(<WatchManagerSkeleton />);

    const root = screen.getByTestId('watch-manager-skeleton');
    expect(root).toBeInTheDocument();
    expect(root).toHaveClass(
      'w-full',
      'max-w-xl',
      'mx-auto',
      'flex',
      'flex-col',
      'gap-y-6',
      'text-center',
    );
    expect(container.querySelector('.min-h-\\[360px\\]')).not.toBeNull();
  });

  it('is textless and hidden from assistive tech', () => {
    render(<WatchManagerSkeleton />);

    const root = screen.getByTestId('watch-manager-skeleton');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.textContent).toBe('');
  });

  it('shows pulse blocks for title, body and actions', () => {
    const { container } = render(<WatchManagerSkeleton />);

    const pulses = container.querySelectorAll('.animate-pulse');
    // Title + 2 body lines + 2 footer buttons.
    expect(pulses.length).toBeGreaterThanOrEqual(5);
  });
});

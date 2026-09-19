import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import DropdownArrow from './DropdownArrow';

describe('DropdownArrow', () => {
  it('renders a decorative, non-interactive caret', () => {
    render(<DropdownArrow />);

    const arrow = screen.getByTestId('dropdown-arrow');
    // Decorative: hidden from assistive tech and never intercepts clicks.
    expect(arrow).toHaveAttribute('aria-hidden', 'true');
    expect(arrow).toHaveClass('pointer-events-none');
    // Diamond recipe: square + 45-degree rotation, only the top/left
    // borders drawn (they become the caret outline after rotation).
    expect(arrow).toHaveClass('h-2', 'w-2', 'rotate-45', 'border-l', 'border-t');
    expect(arrow).not.toHaveClass('border-r', 'border-b');
    // Panel-matching colors so the caret reads as a continuation of the
    // panel border, and absolute positioning (zero layout impact).
    expect(arrow).toHaveClass('absolute', 'border-gray-600', 'bg-gray-900');
  });

  it('appends an extra className without dropping the defaults', () => {
    render(<DropdownArrow className="right-6" />);

    const arrow = screen.getByTestId('dropdown-arrow');
    expect(arrow).toHaveClass('right-6');
    expect(arrow).toHaveClass('rotate-45', 'bg-gray-900');
  });
});

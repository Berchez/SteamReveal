import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import HoverTooltip from './HoverTooltip';

describe('HoverTooltip', () => {
  it('renders the tooltip text hidden from assistive tech', () => {
    render(<HoverTooltip text="Share" />);
    const bubble = screen.getByText('Share');
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveAttribute('aria-hidden', 'true');
  });

  it('starts invisible until group hover/focus (CSS-driven)', () => {
    render(<HoverTooltip text="Copy link" />);
    expect(screen.getByText('Copy link')).toHaveClass('opacity-0');
  });
});

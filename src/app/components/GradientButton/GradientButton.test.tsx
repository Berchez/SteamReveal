import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import GradientButton from './GradientButton';

describe('GradientButton', () => {
  it('renders children and fires onClick', () => {
    const onClick = jest.fn();
    render(<GradientButton onClick={onClick}>Press me</GradientButton>);
    const button = screen.getByRole('button', { name: 'Press me' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('honours the disabled state', () => {
    const onClick = jest.fn();
    render(
      <GradientButton onClick={onClick} disabled>
        Blocked
      </GradientButton>,
    );
    const button = screen.getByRole('button', { name: 'Blocked' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards menu-trigger a11y attributes and the ref', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <GradientButton
        onClick={() => undefined}
        ariaLabel="Share"
        ariaHaspopup="menu"
        ariaExpanded
        ariaControls="share-menu"
        buttonRef={ref}
      >
        Share
      </GradientButton>,
    );
    const button = screen.getByRole('button', { name: 'Share' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'share-menu');
    expect(ref.current).toBe(button);
  });
});

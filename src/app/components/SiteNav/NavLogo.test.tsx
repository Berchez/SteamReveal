import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import NavLogo from './NavLogo';

describe('NavLogo', () => {
  it('renders the home link with the skeleton covering the logo until it loads', async () => {
    render(<NavLogo />);

    const link = screen.getByRole('link', { name: 'SteamReveal' });
    expect(link).toHaveAttribute('href', '/');
    // Image mounts immediately (it owns the load, decorative alt — the
    // link's aria-label is the accessible name); the skeleton overlays it
    // until the load completes — the same never-empty-gap contract as
    // the Suspense fallback.
    expect(screen.getByAltText('')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).not.toBeNull();

    // next/image dispatches the user onLoad outside fireEvent's act
    // scope (internal handler), so the state update needs an async act
    // flush before asserting.
    await act(async () => {
      fireEvent.load(screen.getByAltText(''));
    });

    expect(document.querySelector('.animate-pulse')).toBeNull();
    expect(screen.getByAltText('')).toBeInTheDocument();
  });

  it('falls back to the wordmark when the logo image fails to load', () => {
    // No async act needed here, unlike the load test above: next/image
    // forwards error events SYNCHRONOUSLY through the React synthetic
    // handler (verified in the installed 14.2 image-component — the user
    // onError is called inline), so the state update lands inside
    // fireEvent's act scope deterministically. The load path is the
    // intercepted one (blur-placeholder decode happens first).
    render(<NavLogo />);

    fireEvent.error(screen.getByAltText(''));

    expect(screen.getByText('SteamReveal')).toBeInTheDocument();
    expect(screen.queryByAltText('')).not.toBeInTheDocument();
    // No orphan skeleton next to the wordmark.
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });
});

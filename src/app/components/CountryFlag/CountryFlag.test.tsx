import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import CountryFlag from './CountryFlag';

describe('CountryFlag', () => {
  it('renders the flagcdn image with dimensions, tooltip and no-referrer', () => {
    render(<CountryFlag code="br" label="Brazil" />);

    const img = screen.getByRole('img', { name: 'Brazil' });
    expect(img).toHaveAttribute(
      'src',
      'https://flagcdn.com/w20/br.png',
    );
    expect(img).toHaveAttribute(
      'srcSet',
      'https://flagcdn.com/w40/br.png 2x',
    );
    expect(img).toHaveAttribute('alt', 'Brazil');
    expect(img).toHaveAttribute('title', 'Brazil');
    expect(img).toHaveAttribute('width', '20');
    expect(img).toHaveAttribute('height', '14');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('renders nothing for malformed codes (footgun closed at the choke point)', () => {
    const { container } = render(<CountryFlag code="BRA" label="Brazil" />);
    expect(container).toBeEmptyDOMElement();

    const { container: empty } = render(
      <CountryFlag code="" label="Brazil" />,
    );
    expect(empty).toBeEmptyDOMElement();
  });

  it('degrades to code letters with the SAME accessible name when the CDN fails', () => {
    render(<CountryFlag code="br" label="Brazil" />);

    fireEvent.error(screen.getByRole('img', { name: 'Brazil' }));

    // The fallback keeps the full accessible name (role="img" +
    // aria-label), so screen readers/tooltip never regress from "Brazil"
    // to a bare "BR" when the image fails.
    const fallback = screen.getByRole('img', { name: 'Brazil' });
    expect(fallback).toHaveAttribute('title', 'Brazil');
    expect(fallback).toHaveTextContent('BR');
  });

  it('recovers the image when the code changes after a failure', () => {
    const { rerender } = render(<CountryFlag code="br" label="Brazil" />);
    fireEvent.error(screen.getByRole('img', { name: 'Brazil' }));
    expect(screen.getByRole('img', { name: 'Brazil' })).toHaveTextContent('BR');

    // Same instance reused for another country (e.g. the switcher
    // button after a locale change): the stale failure must not stick.
    rerender(<CountryFlag code="us" label="United States" />);
    expect(screen.getByRole('img', { name: 'United States' })).toHaveAttribute(
      'src',
      'https://flagcdn.com/w20/us.png',
    );
  });

  it('catches failures that fired before hydration (SSR navbar)', () => {
    // jsdom images are never complete: emulate a server-rendered <img>
    // whose error already settled before React attached onError.
    const complete = jest
      .spyOn(HTMLImageElement.prototype, 'complete', 'get')
      .mockReturnValue(true);
    const naturalWidth = jest
      .spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get')
      .mockReturnValue(0);
    try {
      render(<CountryFlag code="br" label="Brazil" />);
      const fallback = screen.getByRole('img', { name: 'Brazil' });
      expect(fallback).toHaveTextContent('BR');
    } finally {
      complete.mockRestore();
      naturalWidth.mockRestore();
    }
  });

  it('keeps image and fallback in the same fixed box (no layout shift)', () => {
    const { container } = render(
      <CountryFlag code="br" label="Brazil" />,
    );
    const boxBefore = container.firstElementChild?.className ?? '';

    fireEvent.error(screen.getByRole('img', { name: 'Brazil' }));
    const boxAfter = container.firstElementChild?.className ?? '';

    expect(boxBefore).toContain('h-3.5');
    expect(boxBefore).toContain('w-5');
    expect(boxAfter).toContain('h-3.5');
    expect(boxAfter).toContain('w-5');
  });

  it('supports a same-origin src override (self-hosted navbar flags)', () => {
    render(<CountryFlag code="br" label="" src="/flags/br.png" />);

    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/flags/br.png');
    expect(img?.getAttribute('srcSet')).toBeNull();
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('supports decorative use (empty label, no tooltip)', () => {
    render(<CountryFlag code="de" label="" />);

    // alt="" drops the image from the accessibility tree by design.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      'https://flagcdn.com/w20/de.png',
    );
    expect(img?.getAttribute('title')).toBeNull();
  });

  it('keeps a DECORATIVE icon decorative when the image fails (no a11y leak)', () => {
    // Navbar switcher shape (label=""): the letters fallback must not
    // gain role/aria semantics the alt="" image never had — a failed
    // icon must not leak "BR" into the parent button's accessible name.
    render(<CountryFlag code="br" label="" />);

    fireEvent.error(screen.getByAltText(''));

    const fallback = screen.getByTestId('country-flag-fallback');
    expect(fallback).toHaveTextContent('BR');
    expect(fallback).not.toHaveAttribute('role');
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows a skeleton placeholder until the image loads, then fades in', () => {
    render(<CountryFlag code="br" label="Brazil" />);

    const skeleton = screen.getByTestId('country-flag-skeleton');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('img', { name: 'Brazil' })).toHaveClass(
      'opacity-0',
    );

    fireEvent.load(screen.getByRole('img', { name: 'Brazil' }));

    expect(
      screen.queryByTestId('country-flag-skeleton'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Brazil' })).toHaveClass(
      'opacity-100',
    );
  });

  it('skips the skeleton for already-cached images (no stuck placeholder)', () => {
    // complete + nonzero width on mount (browser cache, or SSR content
    // already painted): the load event may never fire, so the mount
    // check must mark it loaded instead of leaving gray forever.
    const complete = jest
      .spyOn(HTMLImageElement.prototype, 'complete', 'get')
      .mockReturnValue(true);
    const naturalWidth = jest
      .spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get')
      .mockReturnValue(1);
    try {
      render(<CountryFlag code="br" label="Brazil" />);
      expect(
        screen.queryByTestId('country-flag-skeleton'),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Brazil' })).toHaveClass(
        'opacity-100',
      );
    } finally {
      complete.mockRestore();
      naturalWidth.mockRestore();
    }
  });
});

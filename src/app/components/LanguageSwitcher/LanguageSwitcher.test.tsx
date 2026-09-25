import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import LanguageSwitcher from './LanguageSwitcher';

// Key-echo (WatchManager precedent): the button aria-label carries the
// toggleMenu key, which the tests observe verbatim.
const mockTranslate = (key: string) => key;
const mockReplace = jest.fn();

jest.mock('next-intl', () => ({
  useLocale: () => 'pt',
  useTranslations: () => mockTranslate,
}));

// Same interception precedent as WatchManager/UserCard tests: mock the
// underlying next-intl/navigation factory (not the @/navigation alias).
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    redirect: jest.fn(),
    usePathname: () => '/player/player-x',
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: mockReplace })),
    getPathname: jest.fn(),
  }),
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ entries: () => [] }),
}));

const FLAG_CODES: Record<string, string> = {
  English: 'us',
  Português: 'br',
  Русский: 'ru',
  Deutsch: 'de',
  Español: 'es',
  Français: 'fr',
  Українська: 'ua',
  Polski: 'pl',
};

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the current locale as a flag image (not emoji) plus its name', () => {
    render(<LanguageSwitcher />);

    // pt is the mocked locale: self-hosted Brazilian flag image plus
    // visible name. Same-origin asset (public/flags): the navbar mounts
    // on every page, so its flags must never cost a third-party request.
    // The icon is decorative (alt=""), so it has no img role — the button
    // keeps its accessible name from the aria-label instead.
    const flag = screen.getByAltText('');
    expect(flag).toHaveAttribute('src', '/flags/br.png');
    expect(flag).toHaveAttribute('alt', '');
    expect(screen.getByText('Português')).toBeInTheDocument();
    expect(screen.getByTestId('language-switcher')).toHaveAttribute(
      'aria-label',
      'Português - toggleMenu',
    );
  });

  it('lists every locale with a flag image and no emoji anywhere', () => {
    render(<LanguageSwitcher />);

    fireEvent.click(screen.getByTestId('language-switcher'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByTestId('language-switcher')).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(8);
    for (const [name, code] of Object.entries(FLAG_CODES)) {
      const item = items.find((li) =>
        li.textContent?.includes(name),
      );
      expect(item).toBeDefined();
      const img = item?.querySelector('img');
      expect(img?.getAttribute('src')).toBe(`/flags/${code}.png`);
      // Same-origin: no third-party request from the global navbar.
      expect(img?.getAttribute('src')).not.toContain('://');
    }
    // Windows has no flag glyphs: any regional-indicator char here
    // would render as bare letters on desktop Chrome/Edge. Compared by
    // code point (no \u escapes) so the assertion itself needs no emoji.
    const text = document.body.textContent ?? '';
    let hasFlagChar = false;
    for (let i = 0; i < text.length; i += 1) {
      const cp = text.codePointAt(i) ?? 0;
      if (cp >= 0x1f1e6 && cp <= 0x1f1ff) hasFlagChar = true;
      if (cp > 0xffff) i += 1;
    }
    expect(hasFlagChar).toBe(false);
  });

  it('replaces the locale preserving path and query on menu click', () => {
    render(<LanguageSwitcher />);

    fireEvent.click(screen.getByTestId('language-switcher'));
    fireEvent.click(screen.getByText('Español'));

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(
      { pathname: '/player/player-x', query: {} },
      { locale: 'es' },
    );
  });
});

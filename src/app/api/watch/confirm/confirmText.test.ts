import { WATCH_LOCALES } from '@/lib/watch/notificationText';

import { CONFIRM_PAGE_TEXT } from './confirmText';

describe('CONFIRM_PAGE_TEXT locale parity', () => {
  it('covers exactly the 5 supported locales', () => {
    expect(Object.keys(CONFIRM_PAGE_TEXT).sort()).toEqual(
      [...WATCH_LOCALES].sort(),
    );
  });

  it.each([...WATCH_LOCALES])(
    'carries every field, non-empty, in %s (lang matches key)',
    (locale) => {
      const text = CONFIRM_PAGE_TEXT[locale];
      expect(text.lang).toBe(locale);
      for (const field of [
        'title',
        'body',
        'button',
        'expiredTitle',
        'expiredBody',
        'homeLink',
      ] as const) {
        expect(typeof text[field]).toBe('string');
        expect(text[field].length).toBeGreaterThan(0);
      }
    },
  );
});

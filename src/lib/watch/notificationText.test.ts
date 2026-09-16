import {
  DEFAULT_WATCH_LOCALE,
  getConfirmExpiredText,
  getConfirmText,
  getInboxSearchDateTime,
  getNotifyTeaserText,
  getNotifyText,
  getWelcomeText,
  resolveWatchLocale,
  WATCH_LOCALES,
  watchProfileUrl,
} from './notificationText';

const STEAM = '76561198000000001';
const CONFIRM_URL = 'https://steam-reveal.vercel.app/api/watch/confirm?token=abc123';

describe('resolveWatchLocale', () => {
  it('resolves base languages and regional variants', () => {
    expect(resolveWatchLocale('pt')).toBe('pt');
    expect(resolveWatchLocale('pt-BR')).toBe('pt');
    expect(resolveWatchLocale('PT-br')).toBe('pt');
    expect(resolveWatchLocale('de')).toBe('de');
  });

  it('falls back to English for unknown, empty, or absent locales', () => {
    expect(resolveWatchLocale('xx')).toBe(DEFAULT_WATCH_LOCALE);
    expect(resolveWatchLocale('')).toBe(DEFAULT_WATCH_LOCALE);
    expect(resolveWatchLocale(null)).toBe(DEFAULT_WATCH_LOCALE);
    expect(resolveWatchLocale(undefined)).toBe(DEFAULT_WATCH_LOCALE);
  });
});

describe('shared watch message base', () => {
  it('covers exactly the 5 supported locales', () => {
    expect([...WATCH_LOCALES].sort()).toEqual(
      ['de', 'en', 'es', 'pt', 'ru'].sort(),
    );
  });

  it.each([...WATCH_LOCALES])('welcome text is non-empty in %s', (locale) => {
    expect(getWelcomeText(locale).length).toBeGreaterThan(0);
  });

  it.each([...WATCH_LOCALES])(
    'notify text names the watched profile in %s',
    (locale) => {
      const text = getNotifyText(locale, STEAM);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(STEAM);
      expect(text).toContain(watchProfileUrl(STEAM));
    },
  );

  it.each([...WATCH_LOCALES])(
    'confirm text carries the link in %s',
    (locale) => {
      const text = getConfirmText(locale, CONFIRM_URL);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(CONFIRM_URL);
    },
  );

  it.each([...WATCH_LOCALES])(
    'teaser is a short hook with the link in %s (never the full text)',
    (locale) => {
      const teaser = getNotifyTeaserText(locale, STEAM);
      const full = getNotifyText(locale, STEAM);
      expect(teaser.length).toBeGreaterThan(0);
      expect(teaser).toContain(watchProfileUrl(STEAM));
      expect(teaser).not.toBe(full);
      expect(teaser.length).toBeLessThan(full.length);
    },
  );

  it('teaser names the profile when a nickname is given', () => {
    const text = getNotifyTeaserText('pt', STEAM, { nickname: 'FalleN' });
    expect(text).toContain('(FalleN)');
    expect(text).toContain(watchProfileUrl(STEAM));
  });

  it('teaser carries no opt-out line (welcome owns that)', () => {
    expect(getNotifyTeaserText('en', STEAM)).not.toContain('unfriend');
    expect(getNotifyTeaserText('pt', STEAM)).not.toContain('desfazer a amizade');
  });

  it('teaser falls back to English for unknown locales', () => {
    expect(getNotifyTeaserText('xx', STEAM)).toBe(
      getNotifyTeaserText(DEFAULT_WATCH_LOCALE, STEAM),
    );
  });

  it.each([...WATCH_LOCALES])(
    'expiry-notice text is non-empty in %s (never a link)',
    (locale) => {
      const text = getConfirmExpiredText(locale);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('http');
    },
  );

  it('names the profile and links the player page when provided', () => {
    const text = getNotifyText('pt', STEAM, {
      nickname: 'FalleN',
      siteUrl: 'https://steam-reveal.vercel.app',
    });

    expect(text).toContain('(FalleN)');
    expect(text).toContain(
      `https://steam-reveal.vercel.app/pt/player/${STEAM}`,
    );
    expect(text).not.toContain(watchProfileUrl(STEAM));
  });

  it('carries the anti-loop token on the player-page link', () => {
    const text = getNotifyText('en', STEAM, {
      siteUrl: 'https://steam-reveal.vercel.app',
      antiLoopToken: 'ab'.repeat(32),
    });

    // Regression net for the unwired-token incident: the token the bot
    // issues must reach the link the user clicks, or validation can never
    // succeed and the loop guard is dead code.
    expect(text).toContain(
      `https://steam-reveal.vercel.app/en/player/${STEAM}?anti_loop_token=${'ab'.repeat(32)}`,
    );
  });

  it('falls back to the plain phrasing without nickname or site', () => {
    const text = getNotifyText('pt', STEAM);

    expect(text).not.toContain('(');
    expect(text).toContain(watchProfileUrl(STEAM));
  });

  it('never throws and falls back for unknown locales', () => {
    expect(() => getNotifyText('xx', STEAM)).not.toThrow();
    expect(getNotifyText('xx', STEAM)).toBe(
      getNotifyText(DEFAULT_WATCH_LOCALE, STEAM),
    );
    expect(getWelcomeText(null)).toBe(getWelcomeText(DEFAULT_WATCH_LOCALE));
    expect(getConfirmText('xx', CONFIRM_URL)).toBe(
      getConfirmText(DEFAULT_WATCH_LOCALE, CONFIRM_URL),
    );
    expect(getConfirmExpiredText('xx')).toBe(
      getConfirmExpiredText(DEFAULT_WATCH_LOCALE),
    );
  });

  it('keeps every template free of [ (Steam BBCode mangling)', () => {
    for (const locale of [...WATCH_LOCALES, 'xx', null]) {
      expect(getWelcomeText(locale)).not.toContain('[');
      expect(getNotifyText(locale, STEAM)).not.toContain('[');
      expect(getNotifyTeaserText(locale, STEAM)).not.toContain('[');
      expect(getConfirmText(locale, CONFIRM_URL)).not.toContain('[');
      expect(getConfirmExpiredText(locale)).not.toContain('[');
    }
  });

  it('ships intact UTF-8 in every locale', () => {
    // Guards the Windows-codepage mojibake mirage at the byte level: real
    // Cyrillic / accented text must survive, never U+FFFD.
    expect(getNotifyText('ru', STEAM)).toMatch(/[Ѐ-џ]/);
    expect(getNotifyText('pt', STEAM)).toMatch(/[ãç]/);
    expect(getNotifyText('es', STEAM)).toMatch(/[óí]/);
    expect(getNotifyText('de', STEAM)).toMatch(/[äöüÄÖÜß]/);
    expect(getWelcomeText('ru')).toMatch(/[Ѐ-џ]/);
    expect(getConfirmText('ru', CONFIRM_URL)).toMatch(/[Ѐ-џ]/);
    expect(getConfirmExpiredText('ru')).toMatch(/[Ѐ-џ]/);
    expect(getConfirmExpiredText('pt')).toMatch(/[ãç]/);
    expect(getConfirmExpiredText('es')).toMatch(/[óí]/);
    expect(getConfirmExpiredText('de')).toMatch(/[äöüÄÖÜß]/);
    expect(getNotifyTeaserText('ru', STEAM)).toMatch(/[Ѐ-џ]/);
    expect(getNotifyTeaserText('pt', STEAM)).toMatch(/[ãç]/);
    expect(getNotifyTeaserText('es', STEAM)).toMatch(/[óí]/);
    expect(getNotifyTeaserText('de', STEAM)).toMatch(/[äöüÄÖÜß]/);
    for (const locale of WATCH_LOCALES) {
      expect(getWelcomeText(locale)).not.toContain('�');
      expect(getNotifyText(locale, STEAM)).not.toContain('�');
      expect(getNotifyTeaserText(locale, STEAM)).not.toContain('�');
      expect(getConfirmText(locale, CONFIRM_URL)).not.toContain('�');
      expect(getConfirmExpiredText(locale)).not.toContain('�');
    }
  });

  it('keeps every template in its own language (no cross-locale contamination)', () => {
    // Regression net for whole-sentence pastes across locales (once
    // shipped in WELCOME/CONFIRM es/de/ru): UTF-8 presence checks cannot
    // catch those — the alphabet survives while the language does not —
    // so distinctive per-language words are asserted absent everywhere
    // else. Every marker below occurs in its home locale (the positive
    // side is self-validating: a marker matching nowhere fails loudly
    // here instead of silently weakening the net). Deliberate limit:
    // same-language typos ("aba o este") need native review, not regex.
    const PT_MARKERS = [
      'você',
      'estão',
      'lguém',
      'com este bot',
      'Para parar',
    ];
    const ES_MARKERS = ['¡', 'aquí', 'enlace', 'mira'];
    const DE_MARKERS = [
      'Jemand',
      'Beobachtung',
      'Bestätigung',
      'sobald',
      'über',
      'Freundesliste',
      'einfach',
    ];
    const EN_MARKERS = [' your ', ' the ', 'will ', 'unfriend', 'Steam message'];
    const CYRILLIC_RE = /[Ѐ-џ]/;
    const templatesFor = (locale: string): string[] => [
      getWelcomeText(locale),
      getNotifyText(locale, STEAM),
      getNotifyTeaserText(locale, STEAM),
      getConfirmText(locale, CONFIRM_URL),
      getConfirmExpiredText(locale),
    ];
    const combined: Record<string, string> = {};
    for (const locale of WATCH_LOCALES) {
      combined[locale] = templatesFor(locale).join('\n');
    }
    // Positive (non-vacuous): every marker occurs in its home locale.
    for (const marker of PT_MARKERS) expect(combined.pt).toContain(marker);
    for (const marker of ES_MARKERS) expect(combined.es).toContain(marker);
    for (const marker of DE_MARKERS) expect(combined.de).toContain(marker);
    for (const marker of EN_MARKERS) expect(combined.en).toContain(marker);
    // Negative: no marker leaks into any other locale's templates.
    const forbidden: Record<string, string[]> = {
      en: [...PT_MARKERS, ...ES_MARKERS, ...DE_MARKERS],
      pt: [...ES_MARKERS, ...DE_MARKERS, ...EN_MARKERS],
      es: [...PT_MARKERS, ...DE_MARKERS, ...EN_MARKERS],
      de: [...PT_MARKERS, ...ES_MARKERS, ...EN_MARKERS],
      ru: [...PT_MARKERS, ...ES_MARKERS, ...DE_MARKERS, ...EN_MARKERS],
    };
    for (const locale of WATCH_LOCALES) {
      for (const marker of forbidden[locale]) {
        for (const text of templatesFor(locale)) {
          expect(text).not.toContain(marker);
        }
      }
      // Cyrillic lives exclusively in ru templates (and in every one).
      for (const text of templatesFor(locale)) {
        if (locale === 'ru') {
          expect(text).toMatch(CYRILLIC_RE);
        } else {
          expect(text).not.toMatch(CYRILLIC_RE);
        }
      }
    }
  });
});

describe('getInboxSearchDateTime', () => {
  // Noon UTC keeps the local calendar day identical in the UTC-12..UTC+12
  // band (the day only rolls past UTC+12, where no CI/dev box sits), and
  // every expectation below derives its digits from the same local Date —
  // so the assertions hold in any timezone.
  const ISO = '2026-09-15T12:00:00.000Z';
  const localDay = (d: Date): string =>
    d.getDate().toString().padStart(2, '0');
  const localMonth = (d: Date): string =>
    (d.getMonth() + 1).toString().padStart(2, '0');

  it('formats US month-first date and 12h time in en', () => {
    const parts = getInboxSearchDateTime(ISO, 'en');
    expect(parts).not.toBeNull();
    const d = new Date(ISO);
    // MM precedes DD…
    expect(parts!.date.indexOf(localMonth(d))).toBeLessThan(
      parts!.date.indexOf(localDay(d)),
    );
    // …and the clock reads 12h with a meridiem.
    expect(parts!.time).toMatch(/AM|PM/i);
  });

  it('formats day-first date and 24h time in pt', () => {
    const parts = getInboxSearchDateTime(ISO, 'pt');
    expect(parts).not.toBeNull();
    const d = new Date(ISO);
    // DD precedes MM…
    expect(parts!.date.indexOf(localDay(d))).toBeLessThan(
      parts!.date.indexOf(localMonth(d)),
    );
    // …and the clock stays 24h (no meridiem).
    expect(parts!.time).not.toMatch(/AM|PM/i);
    expect(parts!.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('matches the platform Intl output for the same locale', () => {
    const d = new Date(ISO);
    expect(getInboxSearchDateTime(ISO, 'de')).toEqual({
      date: new Intl.DateTimeFormat('de', {
        day: '2-digit',
        month: '2-digit',
      }).format(d),
      time: new Intl.DateTimeFormat('de', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(d),
    });
  });

  it('normalizes regional variants and unknown locales like everywhere else', () => {
    expect(getInboxSearchDateTime(ISO, 'pt-BR')).toEqual(
      getInboxSearchDateTime(ISO, 'pt'),
    );
    expect(getInboxSearchDateTime(ISO, 'xx')).toEqual(
      getInboxSearchDateTime(ISO, 'en'),
    );
  });

  it('returns null for absent or malformed input, never throws', () => {
    expect(getInboxSearchDateTime(null, 'en')).toBeNull();
    expect(getInboxSearchDateTime(undefined, 'en')).toBeNull();
    expect(getInboxSearchDateTime('', 'en')).toBeNull();
    expect(getInboxSearchDateTime('not-a-date', 'en')).toBeNull();
  });
});

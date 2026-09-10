/**
 * Locale parity for the Watch namespace (WB-15).
 *
 * Every user-facing Watch string must exist in all 5 locales — a missing
 * key renders as a raw key (or crashes, depending on the next-intl
 * setting) for that language. This test fails loudly on any drift,
 * including the inbox keys added by the Epic 7 UI.
 *
 * NOTE: messages/*.json start with a UTF-8 BOM, stripped before parsing.
 */

import fs from 'fs';
import path from 'path';

import { WATCH_LOCALES } from './notificationText';

// Single source (not redeclared): if a locale is added/removed in the
// base module, this suite automatically follows instead of silently
// testing a stale list.
const LOCALES: readonly string[] = WATCH_LOCALES;

const INBOX_KEYS = [
  'watchInboxTitle',
  'watchInboxBellLabel',
  'watchInboxEmpty',
  'watchInboxLoading',
  'watchInboxError',
  'watchInboxRetry',
];

const loadMessages = (locale: string): Record<string, unknown> => {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'messages', `${locale}.json`),
    'utf8',
  );
  // Files start with a UTF-8 BOM: strip by codepoint (a literal would be
  // invisible in review) before parsing.
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(withoutBom) as Record<string, unknown>;
};

describe('Watch locale parity (WB-15)', () => {
  it('parses all 5 locale files', () => {
    for (const locale of LOCALES) {
      expect(() => loadMessages(locale)).not.toThrow();
    }
  });

  it('keeps identical Watch key sets across all locales', () => {
    const keySets = LOCALES.map((locale) => {
      const messages = loadMessages(locale);
      const watch = messages.Watch as Record<string, unknown>;
      expect(watch).toBeDefined();
      return Object.keys(watch).sort();
    });
    for (const keys of keySets.slice(1)) {
      expect(keys).toEqual(keySets[0]);
    }
  });

  it('carries every inbox key, non-empty, in all locales', () => {
    for (const locale of LOCALES) {
      const watch = loadMessages(locale).Watch as Record<string, unknown>;
      for (const key of INBOX_KEYS) {
        expect(typeof watch[key]).toBe('string');
        expect((watch[key] as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the unread-count interpolation in every bell label', () => {
    // The component renders translator('watchInboxBellLabel', { count }):
    // a label without the placeholder would silently drop the number.
    for (const locale of LOCALES) {
      const watch = loadMessages(locale).Watch as Record<string, unknown>;
      expect(watch.watchInboxBellLabel as string).toContain('{count}');
    }
  });
});

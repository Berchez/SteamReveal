import fs from 'fs';
import path from 'path';

import { SUPPORTED_LOCALES } from './locales';

/**
 * Message-catalog parity: every locale must carry EXACTLY the same key
 * tree as `en` (the source catalog). A missing key crashes next-intl at
 * render (`t('...')` on an absent path), and an extra key means dead copy
 * nobody reviews — both fail here instead of in production. New locales
 * are covered automatically via SUPPORTED_LOCALES (adding 'xx' without a
 * messages/xx.json fails loudly on the read below, same as a missing file
 * would fail the dev server).
 */

const keyPaths = (node: unknown, prefix = ''): string[] => {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return [prefix];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(
    ([key, value]) =>
      keyPaths(value, prefix === '' ? key : `${prefix}.${key}`),
  );
};

const readCatalog = (locale: string): unknown => {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'messages', `${locale}.json`),
    'utf8',
  );
  return JSON.parse(raw);
};

describe('message catalog parity (all SUPPORTED_LOCALES vs en)', () => {
  const reference = keyPaths(readCatalog('en')).sort();

  it.each([...SUPPORTED_LOCALES].filter((locale) => locale !== 'en'))(
    'locale %s carries exactly the en key tree (no missing, no extra)',
    (locale) => {
      const actual = keyPaths(readCatalog(locale)).sort();
      const missing = reference.filter((key) => !actual.includes(key));
      const extra = actual.filter((key) => !reference.includes(key));

      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    },
  );

  it('every leaf is a non-empty string (no null/blank copy ships)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const walk = (node: unknown, trail: string): void => {
        if (typeof node === 'string') {
          expect(`${locale}:${trail}`).not.toEqual(`${locale}:`);
          expect(node.trim().length).toBeGreaterThan(0);
          return;
        }
        Object.entries(node as Record<string, unknown>).forEach(
          ([key, value]) => walk(value, `${trail}.${key}`),
        );
      };
      walk(readCatalog(locale), locale);
    }
  });
});

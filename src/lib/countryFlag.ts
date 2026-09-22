/**
 * Country flag helpers (images + display names).
 *
 * Flag images come from flagcdn — NOT emoji: Windows ships no flag
 * glyphs in its emoji font, so emoji render as bare "BR" letters on
 * desktop Chrome/Edge. Images render identically on every platform
 * (same source the LocationCard already uses for profile flags).
 *
 * Country names come from Intl.DisplayNames (ships with the runtime),
 * so all 5 site locales are covered with zero entries in
 * messages/*.json. Names are used bare (tooltips, alt text), never
 * interpolated into a sentence — no gender/article handling needed.
 */

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

/**
 * Single choke point for 2-letter ISO country codes (isomorphic — the
 * DAL, the write parser and the UI all share it): malformed values
 * (hand edits, corrupt imports, wrong-typed payloads) collapse to null
 * instead of reaching a flag URL, a GROUP BY bucket, or a glyph.
 */
export const normalizeCountryCode = (value: unknown): string | null =>
  typeof value === 'string' && COUNTRY_CODE_RE.test(value)
    ? value.toUpperCase()
    : null;

/** flagcdn URL for a 2-letter ISO country code (callers validate). */
export const flagImageUrl = (countryCode: string, width = 20): string =>
  `https://flagcdn.com/w${width}/${countryCode.toLowerCase()}.png`;

// One instance per locale (module-scoped, per warm instance like the
// rate limiters): constructing Intl.DisplayNames per inbox row would
// rebuild the same ICU object up to 50x per panel open.
const displayNamesCache = new Map<string, Intl.DisplayNames | null>();

const getDisplayNames = (locale: string): Intl.DisplayNames | null => {
  const cached = displayNamesCache.get(locale);
  if (cached !== undefined) return cached;
  let instance: Intl.DisplayNames | null = null;
  try {
    instance = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    instance = null;
  }
  displayNamesCache.set(locale, instance);
  return instance;
};

/**
 * Display name for a 2-letter country code in the given UI locale.
 * Null when the code is absent, malformed, or unknown to the runtime —
 * callers then render flagless instead of a broken glyph. Note:
 * DisplayNames resolves unassigned codes (e.g. 'XX') to themselves
 * rather than throwing, so an echo-back is treated as unknown too.
 */
export const countryDisplayName = (
  countryCode: string | null | undefined,
  locale: string,
): string | null => {
  const upper = normalizeCountryCode(countryCode);
  if (upper === null) return null;
  try {
    const name = getDisplayNames(locale)?.of(upper) ?? null;
    return name !== null && name !== upper ? name : null;
  } catch {
    return null;
  }
};

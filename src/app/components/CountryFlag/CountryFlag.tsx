'use client';

import React, { useEffect, useRef, useState } from 'react';
import { flagImageUrl, normalizeCountryCode } from '@/lib/countryFlag';

interface CountryFlagProps {
  /** 2-letter ISO country code (any case). Malformed codes render nothing. */
  code: string;
  /** Accessible name + hover tooltip. Empty string = decorative. */
  label: string;
  className?: string;
  /**
   * Same-origin override (e.g. "/flags/br.png" for the navbar's fixed
   * set): skips the CDN entirely — no third-party request, no failure
   * mode. Defaults to flagcdn (dynamic countries only the CDN covers).
   */
  src?: string;
}

// Fixed box: image, skeleton and fallback occupy exactly the same
// 20x14 space, so neither load nor failure shifts layout (CLS = 0).
// object-contain keeps non-rectangular flags (Nepal, Switzerland)
// undistorted.
const BOX_CLASS = 'inline-flex h-3.5 w-5 shrink-0 items-center justify-center';

/**
 * Shared country-flag image (flagcdn, not emoji — Windows ships no flag
 * glyphs in its emoji font, so emoji render as bare "BR" letters on
 * desktop Chrome/Edge).
 *
 * Hardening, all in one place so every flag in the product inherits it:
 * - referrerPolicy="no-referrer": a cross-origin CDN must not learn the
 *   page origin from our markup — matters in an OSINT product. (Same-
 *   origin `src` overrides skip the CDN — and the third party — fully.)
 * - width/height + w40 srcSet: layout space is reserved before load (no
 *   CLS) and retina screens get a crisp 2x asset.
 * - Loading skeleton: a gray pulse fills the fixed box until onLoad, so
 *   slow CDN images never leave a blank gap (same visual language as the
 *   NavLogo skeleton). Fades out via opacity transition, never shifts.
 * - Failure fallback with the same box: a blocked/down CDN degrades to
 *   code letters ("BR") instead of a broken-image icon — the navbar must
 *   never show a broken glyph on every page. The failure is keyed by
 *   code (not a boolean), so a reused instance recovers when `code`
 *   changes; and a mount check (`complete && naturalWidth === 0`)
 *   catches errors that fired before hydration, when onError can never
 *   run.
 */
function CountryFlag({ code, label, className = '', src }: CountryFlagProps) {
  const normalized = normalizeCountryCode(code);
  // Which code failed (null = none): resets on its own when `code`
  // changes, so a reused instance never sticks on stale letters.
  const [failedCode, setFailedCode] = useState<string | null>(null);
  // Src that finished loading (not a boolean: keyed by src, so swapping
  // codes starts a fresh load cycle instead of flashing the new image at
  // full opacity on stale state).
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const resolvedSrc = src ?? (normalized === null ? '' : flagImageUrl(normalized));
  const resolvedSrcSet =
    src !== undefined || normalized === null
      ? undefined
      : `${flagImageUrl(normalized, 40)} 2x`;
  const loaded = loadedSrc === resolvedSrc;

  // SSR gap: load/error may have settled before hydration
  // (server-rendered navbar), when onLoad/onError can never run —
  // re-check on mount and on every code/src change. Cached images land
  // here as complete with nonzero width (no stuck skeleton); broken ones
  // as complete with zero width (fallback without waiting).
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth === 0) {
      setFailedCode(normalized);
    } else {
      setLoadedSrc(resolvedSrc);
    }
  }, [normalized, resolvedSrc]);

  if (normalized === null) return null;

  if (failedCode === normalized) {
    // Decorative use (label="", like the navbar switcher): the fallback
    // must STAY decorative — no role, aria-hidden — matching the image's
    // alt="" semantics, so a failed icon never leaks "BR" into the parent
    // button's accessible name. Labeled use keeps the full name.
    const decorative = label === '';
    return (
      <span
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative || undefined}
        data-testid="country-flag-fallback"
        className={`${BOX_CLASS} text-[9px] font-semibold leading-none ${className}`}
        title={label || undefined}
      >
        {normalized}
      </span>
    );
  }

  return (
    <span className={`${BOX_CLASS} relative ${className}`}>
      {!loaded && (
        <span
          aria-hidden="true"
          data-testid="country-flag-skeleton"
          className="absolute inset-0 animate-pulse rounded-[2px] bg-gray-700"
        />
      )}
      <img
        ref={imgRef}
        src={resolvedSrc}
        srcSet={resolvedSrcSet}
        alt={label}
        title={label || undefined}
        width={20}
        height={14}
        className={`relative object-contain transition-opacity duration-200 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoadedSrc(resolvedSrc)}
        onError={() => setFailedCode(normalized)}
      />
    </span>
  );
}

export default CountryFlag;

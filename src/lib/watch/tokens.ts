/**
 * Single-use Watch token generation (confirm + anti-loop links).
 *
 * One helper so the byte length can never drift between issuer and
 * validator: raw tokens are WATCH_TOKEN_HEX_LENGTH lowercase hex chars
 * (WATCH_TOKEN_BYTES random bytes), the same shape the DAL hash asserts
 * and the confirm route shape-gate expect. Only the SHA-256 hash is ever
 * stored — the raw value travels exactly once (bot chat message /
 * confirm URL) and is then unrecoverable.
 */

import { randomBytes } from 'crypto';

/** 32 bytes -> 64 hex chars, the only raw-token shape this codebase mints. */
export const WATCH_TOKEN_BYTES = 32;

/**
 * Hex length of a minted raw token (bytes × 2). The single source for
 * every raw-token shape check: deriving validators from this (never a
 * `{64}` literal) keeps a future byte-length change from silently
 * rejecting every outstanding link.
 */
export const WATCH_TOKEN_HEX_LENGTH = WATCH_TOKEN_BYTES * 2;

const WATCH_TOKEN_SHAPE_RE = new RegExp(
  `^[0-9a-f]{${WATCH_TOKEN_HEX_LENGTH}}$`,
);

/**
 * Raw-token shape gate (the confirm route's probe filter). Not a security
 * boundary by itself — the SHA-256 hash compare in the DAL is — but it
 * keeps malformed input from ever reaching a hash lookup.
 */
export const isWatchTokenShape = (value: unknown): value is string =>
  typeof value === 'string' && WATCH_TOKEN_SHAPE_RE.test(value);

/**
 * Mints a lowercase-hex token of `byteLength` random bytes. Throws on
 * nonsense input (fail fast: a malformed length must never silently mint
 * a short token that still passes downstream shape checks by luck).
 */
export const generateHexToken = (byteLength: number = WATCH_TOKEN_BYTES): string => {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(
      `generateHexToken needs a positive integer byte length (got ${String(byteLength)})`,
    );
  }
  return randomBytes(byteLength).toString('hex');
};

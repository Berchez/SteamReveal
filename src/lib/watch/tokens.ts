/**
 * Single-use Watch token generation (confirm + anti-loop links).
 *
 * One helper so the byte length can never drift between issuer and
 * validator: raw tokens are 64 lowercase hex chars (N random bytes), the
 * same shape the DAL hash asserts and the confirm route shape-gate expect.
 * Only the SHA-256 hash is ever stored — the raw value travels exactly
 * once (bot chat message / confirm URL) and is then unrecoverable.
 */

import { randomBytes } from 'crypto';

/** 32 bytes -> 64 hex chars, the only raw-token shape this codebase mints. */
export const WATCH_TOKEN_BYTES = 32;

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

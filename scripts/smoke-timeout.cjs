#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Bounded-wait helpers for the pre-push smoke scripts.
 *
 * WHY THIS EXISTS: `pnpm run smoke:analytics` and `pnpm run db:smoke` run
 * inside `.husky/pre-push`, and both used to await `fetch()` / libSQL
 * `client.execute()` calls with NO timeout. Node's fetch has no default
 * timeout and the hrana transport doesn't add one either — so a stalled dev
 * server on :3000 or a black-holed Turso connection made the whole `git
 * push` hang FOREVER (no output, no failure, Ctrl+C orphaning servers).
 *
 * Every wait here is bounded: on expiry the caller gets a rejected promise
 * carrying `code === 'SMOKE_TIMEOUT'` (see isTimeoutError) and — per the
 * repo's transport-failure policy — SKIPS (exit 0) instead of hanging, since
 * a stall is an environment problem, not an analytics regression.
 *
 * Cross-version note: uses AbortSignal.timeout() (Node >= 17.3; engines pin
 * Node 22.x). The withTimeout() race additionally guards non-fetch promises
 * (libSQL execute/batch) that don't accept an AbortSignal.
 *
 * NOTE: src/lib/withTimeout.ts is a SEPARATE, Steam-call-specific helper
 * (SteamCallTimeoutError, different arg order, tuned 8s default) used by the
 * app runtime — do not merge the two. This module is the smoke scripts'
 * counterpart: code-marked errors for SKIP decisions, an AbortSignal fetch
 * helper, and unref'd timers so a stalled op never keeps the hook alive.
 *
 * Usage (from the ts-node smokes):
 *   const { withTimeout, fetchWithTimeout } = require('./smoke-timeout.cjs');
 */

'use strict';

const SMOKE_TIMEOUT_CODE = 'SMOKE_TIMEOUT';

const DEFAULT_FETCH_TIMEOUT_MS = 25_000;
const DEFAULT_DB_TIMEOUT_MS = 25_000;

/**
 * Rejection marker for an expired bound. Carries `code` (not just a message
 * match) so callers can distinguish "stalled dependency, skip the push gate"
 * from a genuine assertion failure without parsing error text. Pure.
 */
const createTimeoutError = (label) =>
  Object.assign(new Error(`SMOKE TIMEOUT: ${label} exceeded its time budget`), {
    code: SMOKE_TIMEOUT_CODE,
    label,
  });

/**
 * True for errors produced by the helpers below when their budget expires
 * (including the DOMException TimeoutError that AbortSignal.timeout() turns
 * a fetch rejection into). Pure (unit-tested).
 */
const isTimeoutError = (error) => {
  if (!error) return false;
  if (error.code === SMOKE_TIMEOUT_CODE) return true;
  // AbortSignal.timeout() rejects fetch with a DOMException named
  // 'TimeoutError' — normalize it to the same predicate so callers have one
  // check for both the fetch path and the withTimeout() race path.
  if (error.name === 'TimeoutError') return true;
  return false;
};

/**
 * Races any promise against a deadline. The loser side is left to settle on
 * its own (there is no cancellation primitive for libSQL execute/batch);
 * the timer is unref'd so a settled-slow operation never keeps the smoke
 * process alive by itself. Pure wrt. timing (unit-tested with fake timers).
 */
const withTimeout = (promise, ms, label) => {
  const budget = Number(ms);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(
      `withTimeout needs a positive finite budget in ms (got: ${ms})`,
    );
  }
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(createTimeoutError(label || 'operation'));
    }, budget);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (error) => {
      clearTimeout(timer);
      throw error;
    },
  );
};

/**
 * fetch() with a hard deadline via AbortSignal.timeout(). Rejects with a
 * TimeoutError DOMException on expiry (see isTimeoutError). Pure wrapper
 * (unit-tested with a mocked global fetch).
 */
const fetchWithTimeout = (url, options, ms) =>
  fetch(url, {
    ...(options || {}),
    signal: AbortSignal.timeout(ms ?? DEFAULT_FETCH_TIMEOUT_MS),
  });

if (require.main === module) {
  // No CLI — this module only exists to be required by the smoke scripts.
  // eslint-disable-next-line no-console
  console.log('smoke-timeout.cjs: library only, nothing to run.');
}

module.exports = {
  SMOKE_TIMEOUT_CODE,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_DB_TIMEOUT_MS,
  createTimeoutError,
  isTimeoutError,
  withTimeout,
  fetchWithTimeout,
};

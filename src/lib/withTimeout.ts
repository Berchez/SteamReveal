// Adjustment (post-PR review, ticket item 9): comment corrected after
// directly inspecting the installed package — the actual project version is
// steamapi@3.0.12, which uses node-fetch (not `got`, and not 3.0.8 as
// previously stated).
//
// Verified against the dependency source code:
// - The SteamAPI constructor options (language, currency, headers, baseAPI,
//   baseStore, baseActions, inMemoryCacheEnabled, gameDetailCacheEnabled,
//   gameDetailCacheTTL, userResolveCacheEnabled, userResolveCacheTTL) do not
//   include `timeout` or `signal`.
// - The internal `get()` method (dist/src/SteamAPI.js) calls
//   `fetch(url, this.headers)`. The HTTP options come from the `headers`
//   constructor option and cannot be customized per request. Although
//   node-fetch@3 supports `signal` through RequestInit, the library does not
//   expose a way to provide it on a per-request basis.
// - The public methods (getUserSummary, getUserFriends, getUserLevel,
//   resolve, etc.) do not accept request options, so there is no supported
//   way to inject an AbortSignal for an individual request.
//
// Conclusion: there is no native timeout or per-request cancellation
// accessible through the library's public API. Alternatives such as
// monkey-patching `this.headers` or replacing the fetch implementation to
// force a `signal` would depend on undocumented internals and be more fragile
// than the problem they solve. Therefore, we opted to keep this
// Promise.race-based wrapper.
//
// Known and accepted limitation: this only cancels the client's wait for the
// result. The underlying HTTP request made by steamapi continues running in
// the background until it resolves or fails on its own — Promise.race does
// not abort the underlying request. Under normal conditions, the losing
// promise is simply discarded, but under a high rate of timeouts, pending
// requests/connections may accumulate for longer than the configured
// timeout suggests.

const DEFAULT_TIMEOUT_MS = 8000;

export class SteamCallTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'SteamCallTimeoutError';
  }
}

export default function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SteamCallTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

import applyRateLimit, { reportSuccess, reportThrottled } from './rateLimit';

export type WithRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  shouldRetry?: (err: unknown) => boolean;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type ErrorWithStatus = {
  status?: number;
  statusCode?: number;
  response?: { status?: number };
};

// Matches 429 across fetch/axios/custom error shapes
const isRateLimitError = (err: unknown): boolean => {
  const typedErr = err as ErrorWithStatus;
  const status =
    typedErr?.status ?? typedErr?.statusCode ?? typedErr?.response?.status;
  return status === 429;
};

export default async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const factor = opts.factor ?? 2;

  let lastErr: unknown;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      // Wait for the global rate limiter before each attempt
      // eslint-disable-next-line no-await-in-loop
      await applyRateLimit();
      // eslint-disable-next-line no-await-in-loop
      const result = await fn();
      // Success: relax the global delay
      reportSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      const rateLimited = isRateLimitError(err);

      if (rateLimited) {
        // Always signal the global limiter, even on the call's last
        // attempt (i.e. even if we're about to throw and give up). This
        // protects other concurrent/future calls from also hammering an
        // upstream that just told us to slow down.
        reportThrottled();
      }

      const shouldRetry = opts.shouldRetry ? opts.shouldRetry(err) : true;
      if (i === attempts || !shouldRetry) throw err;

      if (!rateLimited) {
        // Local exponential backoff with jitter — deliberately skipped for
        // 429s. On a 429, applyRateLimit() on the next attempt will already
        // wait out the freshly-increased global delay (see reportThrottled
        // in rateLimit.ts), so stacking a second, independent local backoff
        // on top would compound the wait unnecessarily. For everything
        // else (timeouts, network errors, 5xx) the global limiter gets no
        // signal at all, so this local backoff is the only thing standing
        // between us and hammering an upstream that's already struggling.
        const backoff = base * factor ** (i - 1);
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        // eslint-disable-next-line no-await-in-loop
        await sleep(jitter);
      }
    }
  }

  throw lastErr;
}

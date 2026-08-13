import applyRateLimit from './rateLimit';

export type WithRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  shouldRetry?: (err: unknown) => boolean;
};

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export default async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const factor = opts.factor ?? 2;

  let lastErr: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      // Respect global rate limiter before each attempt to avoid hammering external services
      await applyRateLimit();
      return await fn();
    } catch (err) {
      lastErr = err;
      const shouldRetry = opts.shouldRetry ? opts.shouldRetry(err) : true;
      if (i === attempts || !shouldRetry) throw err;
      const backoff = base * Math.pow(factor, i - 1);
      // add a small jitter to avoid thundering herd
      const jitter = backoff * (0.5 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }

  throw lastErr;
}

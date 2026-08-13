import withRetry from './withRetry';

jest.setTimeout(10000);

describe('withRetry', () => {
  it('retries until success and returns the value', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });

    const res = await withRetry(fn, { attempts: 5, baseDelayMs: 10, factor: 1.2 });

    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('stops retrying when shouldRetry returns false', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      const err: any = new Error('fatal');
      (err as any).status = 400;
      throw err;
    });

    await expect(
      withRetry(fn, {
        attempts: 3,
        baseDelayMs: 1,
        shouldRetry: (err) => (err as any)?.status !== 400,
      }),
    ).rejects.toThrow('fatal');

    expect(calls).toBe(1);
  });
});

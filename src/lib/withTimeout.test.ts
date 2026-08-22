import withTimeout, { SteamCallTimeoutError } from './withTimeout';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 'label', 100);
    expect(result).toBe('ok');
  });

  it('rejects with the original error when the promise rejects before the timeout', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 'label', 100),
    ).rejects.toThrow('boom');
  });

  it('rejects with SteamCallTimeoutError when the promise is slower than the timeout', async () => {
    const slow = new Promise((resolve) => {
      setTimeout(() => resolve('too late'), 50);
    });

    await expect(withTimeout(slow, 'my-call', 10)).rejects.toBeInstanceOf(
      SteamCallTimeoutError,
    );
  });

  it('includes the label and timeout value in the error message', async () => {
    const slow = new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    await expect(withTimeout(slow, 'my-label', 10)).rejects.toThrow(
      'my-label timed out after 10ms',
    );
  });
});

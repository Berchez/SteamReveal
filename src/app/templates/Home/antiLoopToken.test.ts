import { ANTI_LOOP_TOKEN_PARAM } from '@/lib/watch/notificationText';

type AntiLoopTokenModule = typeof import('./antiLoopToken');

const loadModule = (): AntiLoopTokenModule => {
  let mod: AntiLoopTokenModule | undefined;
  jest.isolateModules(() => {
    mod = require('./antiLoopToken') as AntiLoopTokenModule;
  });
  return mod as AntiLoopTokenModule;
};

describe('antiLoopToken', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/en');
  });

  it('captures the token and strips it from the URL before it can leak', () => {
    const token = 'ab'.repeat(32);
    window.history.replaceState(
      null,
      '',
      `/en/player/123?${ANTI_LOOP_TOKEN_PARAM}=${token}`,
    );
    const { captureAntiLoopTokenFromUrl, getCapturedAntiLoopToken } =
      loadModule();

    captureAntiLoopTokenFromUrl();

    expect(window.location.search).toBe('');
    expect(getCapturedAntiLoopToken()).toBe(token);
  });

  it('reads the token from the URL when capture has not run yet', () => {
    const token = 'cd'.repeat(32);
    window.history.replaceState(
      null,
      '',
      `/en/player/123?${ANTI_LOOP_TOKEN_PARAM}=${token}`,
    );
    const { getCapturedAntiLoopToken } = loadModule();

    expect(getCapturedAntiLoopToken()).toBe(token);
  });

  it('returns undefined and leaves the URL untouched without a token', () => {
    window.history.replaceState(null, '', '/en/player/123?ref=abc');
    const { captureAntiLoopTokenFromUrl, getCapturedAntiLoopToken } =
      loadModule();

    captureAntiLoopTokenFromUrl();

    expect(window.location.search).toBe('?ref=abc');
    expect(getCapturedAntiLoopToken()).toBeUndefined();
  });
});

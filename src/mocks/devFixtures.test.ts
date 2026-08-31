import { isMockModeEnabled, isMockInvalidTarget, makeMockProfile } from './devFixtures';

describe('dev fixtures guard', () => {
  const originalEnv = { ...process.env };

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete (process.env as Record<string, string | undefined>)[key];
      return;
    }

    (process.env as Record<string, string | undefined>)[key] = value;
  };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete (process.env as Record<string, string | undefined>)[key];
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      (process.env as Record<string, string | undefined>)[key] = value;
    }
  });

  it('allows the mock path in local/test runs', () => {
    setEnv('DEV_TEST_MODE', '1');
    setEnv('NODE_ENV', 'test');
    setEnv('VERCEL_ENV', undefined);

    expect(isMockModeEnabled()).toBe(true);
  });

  it('blocks the mock path in Vercel preview/build environments', () => {
    setEnv('DEV_TEST_MODE', '1');
    setEnv('NODE_ENV', 'production');
    setEnv('VERCEL_ENV', 'preview');

    expect(isMockModeEnabled()).toBe(false);
  });

  it('keeps invalid targets rejected even in mock mode', () => {
    expect(isMockInvalidTarget('estainvalido')).toBe(true);
    expect(makeMockProfile('estainvalido')).toBeUndefined();
  });
});

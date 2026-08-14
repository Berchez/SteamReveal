import { getAnalyticsSkipHeaders } from './useHome';

describe('getAnalyticsSkipHeaders', () => {
  const originalLocalStorage = window.localStorage;

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
  });

  it('returns undefined when there is no password stored', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn().mockReturnValue(null),
      },
      writable: true,
    });

    expect(getAnalyticsSkipHeaders()).toBeUndefined();
  });

  it('returns the skip header when a password is stored', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn().mockReturnValue('my-secret'),
      },
      writable: true,
    });

    expect(getAnalyticsSkipHeaders()).toEqual({
      'x-analytics-skip-password': 'my-secret',
    });
  });

  it('returns undefined when localStorage throws (e.g. private mode)', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn().mockImplementation(() => {
          throw new Error('SecurityError');
        }),
      },
      writable: true,
    });

    expect(getAnalyticsSkipHeaders()).toBeUndefined();
  });

  it('returns undefined when window is undefined (SSR)', () => {
    const originalWindow = global.window;
    // @ts-expect-error simulating SSR
    delete global.window;

    expect(getAnalyticsSkipHeaders()).toBeUndefined();

    global.window = originalWindow;
  });
});

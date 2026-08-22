/**
 * @jest-environment node
 */

import getSteamApiKey from '@/lib/getSteamApiKey';
import { SteamCallTimeoutError } from '@/lib/withTimeout';

export {};

const mockResolve = jest.fn();

jest.mock('steamapi', () =>
  jest.fn().mockImplementation(() => ({
    resolve: mockResolve,
  })),
);

jest.mock('../../../lib/getSteamApiKey');
jest.mocked(getSteamApiKey).mockReturnValue('fake-steam-api-key');

// Same rationale as getCheaterProbability's suite: this route now has its
// own rate limiter (item 10), and every test here shares the same
// 'unknown' IP (no x-real-ip/x-forwarded-for set), so without this mock
// the limiter would trip partway through the file and later tests would
// flake with 429 instead of the status they're actually asserting.
// Rate limiting itself is covered separately below, with the real
// limiter, isolated to its own describe block.
jest.mock('../../../lib/rateLimit', () => ({
  createRateLimiter: () => ({ isRateLimited: () => false }),
  getRequestIp: () => 'test-ip',
}));

const { GET } = require('./route') as typeof import('./route');

const makeRequest = (target?: string | null): Request => {
  const url = new URL('http://localhost/api/getSteamId');
  if (target !== undefined && target !== null) {
    url.searchParams.set('target', target);
  }
  return new Request(url, { method: 'GET' });
};

describe('GET /api/getSteamId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 if target query param is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('returns 400 if target query param is an empty/whitespace string', async () => {
    const res = await GET(makeRequest('   '));
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('returns 200 with the resolved steamId on success', async () => {
    mockResolve.mockResolvedValue('76561198000000000');

    const res = await GET(makeRequest('some-vanity-url'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ steamId: '76561198000000000' });
    expect(mockResolve).toHaveBeenCalledWith('some-vanity-url');
  });

  it('returns 400 INVALID_REQUEST when steam.resolve throws the library\'s "Invalid format" TypeError', async () => {
    mockResolve.mockRejectedValue(new TypeError('Invalid format'));

    const res = await GET(makeRequest('lixo_invalido'));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 504 TIMEOUT when steam.resolve exceeds the configured timeout', async () => {
    mockResolve.mockRejectedValue(
      new SteamCallTimeoutError('getSteamId: steam.resolve', 8000),
    );

    const res = await GET(makeRequest('some-vanity-url'));
    const data = await res.json();

    expect(res.status).toBe(504);
    expect(data.error.code).toBe('TIMEOUT');
  });

  it('returns 500 INTERNAL_ERROR for an unrecognized failure', async () => {
    mockResolve.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest('some-vanity-url'));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error.code).toBe('INTERNAL_ERROR');
  });
});

// Isolated from the describe block above so the real (non-mocked) limiter
// can be exercised without interference from the other tests' shared IP.
describe('GET /api/getSteamId — rate limiting', () => {
  it('returns 429 once the configured max requests/window is exceeded', async () => {
    jest.resetModules();

    jest.doMock('../../../lib/rateLimit', () =>
      jest.requireActual('../../../lib/rateLimit'),
    );

    jest.doMock('../../../lib/getSteamApiKey', () => ({
      __esModule: true,
      default: () => 'fake-steam-api-key',
    }));
    jest.doMock('steamapi', () =>
      jest.fn().mockImplementation(() => ({
        resolve: jest.fn().mockResolvedValue('76561198000000000'),
      })),
    );

    const { GET: RealGET } = require('./route') as typeof import('./route');

    const req = () =>
      new Request('http://localhost/api/getSteamId?target=some-vanity-url', {
        method: 'GET',
        headers: { 'x-real-ip': '203.0.113.9' },
      });

    // RATE_LIMIT_MAX for this route is 30/60s — fire 31 requests from the
    // same IP and expect the last one to be blocked.
    let lastRes: Response | undefined;
    for (let i = 0; i < 31; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      lastRes = await RealGET(req());
    }

    expect(lastRes?.status).toBe(429);
    const data = await lastRes?.json();
    expect(data.error.code).toBe('RATE_LIMITED');

    jest.dontMock('../../../lib/getSteamApiKey');
    jest.dontMock('steamapi');

    jest.doMock('../../../lib/rateLimit', () => ({
      createRateLimiter: () => ({ isRateLimited: () => false }),
      getRequestIp: () => 'test-ip',
    }));
  });
});

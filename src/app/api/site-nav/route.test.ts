/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

import { GET } from './route';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/app/components/SiteNav/siteNavState', () => ({
  resolveSiteNavState: jest.fn(),
}));

jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

const { resolveSiteNavState } = jest.requireMock(
  '@/app/components/SiteNav/siteNavState',
) as { resolveSiteNavState: jest.Mock };

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const STEAM = '76561198000000001';

const makeRequest = (headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/site-nav', { headers });

describe('GET /api/site-nav', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveSiteNavState.mockResolvedValue({
      steamId: null,
      botOnline: true,
    });
  });

  it('returns the private navbar state without caching it', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({
      steamId: null,
      botOnline: true,
    });
  });

  it('seeds the country cookie from the edge header when absent', async () => {
    const response = await GET(
      makeRequest({ 'x-vercel-ip-country': 'br' }),
    );

    expect(response.cookies.get('steamreveal_country')?.value).toBe('BR');
  });

  it('does not overwrite an existing country cookie', async () => {
    const request = new NextRequest('http://localhost/api/site-nav', {
      headers: { 'x-vercel-ip-country': 'US' },
    });
    request.cookies.set('steamreveal_country', 'PT');

    const response = await GET(request);

    expect(response.cookies.get('steamreveal_country')).toBeUndefined();
  });

  it('returns the logged-in shape untouched', async () => {
    resolveSiteNavState.mockResolvedValue({
      steamId: STEAM,
      nickname: 'AvatarUser',
      avatarUrl: null,
      initialWatch: null,
    });

    const response = await GET(makeRequest());

    await expect(response.json()).resolves.toEqual({
      steamId: STEAM,
      nickname: 'AvatarUser',
      avatarUrl: null,
      initialWatch: null,
    });
  });

  it('rate-limits without resolving session state', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const response = await GET(makeRequest());

    expect(response.status).toBe(429);
    expect(resolveSiteNavState).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment node
 */

import axios from 'axios';
import logRouteError from '@/lib/logRouteError';
import GC_NAME_CACHE_SECONDS from '@/lib/gamersClubNameCache';
import { POST } from './route';

jest.mock('axios');
jest.mock('@/lib/logRouteError', () => jest.fn());

const mockedAxiosGet = jest.mocked(axios.get);
const mockedLogRouteError = jest.mocked(logRouteError);

const ORIGINAL_PROXY_URL = process.env.LOCAL_PROXY_URL;

const makeRequest = (body: string) =>
  new Request('http://localhost/api/getGamersClubName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

const post = (body: unknown) => POST(makeRequest(JSON.stringify(body)));

describe('POST /api/getGamersClubName', () => {
  beforeEach(() => {
    mockedAxiosGet.mockReset();
    mockedLogRouteError.mockReset();
    process.env.LOCAL_PROXY_URL = 'http://proxy.local/';
  });

  afterAll(() => {
    if (ORIGINAL_PROXY_URL === undefined) {
      delete process.env.LOCAL_PROXY_URL;
    } else {
      process.env.LOCAL_PROXY_URL = ORIGINAL_PROXY_URL;
    }
  });

  it('pins the server-side GC Name cache to three days', () => {
    expect(GC_NAME_CACHE_SECONDS).toBe(259200);
  });

  it('rejects a missing or invalid steamId without touching the proxy', async () => {
    for (const body of [{}, { steamId: 123 }]) {
      const response = await post(body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const response = await POST(makeRequest('{'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('returns a confirmed name and defaults allowScrape to true', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      status: 200,
      data: { name: 'aliceCS', notFound: false },
    });

    const response = await post({ steamId: '76561198000000001' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      steamId: '76561198000000001',
      gcName: 'aliceCS',
      notFound: false,
      unavailable: false,
    });
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'http://proxy.local/api/gamersclub/76561198000000001?allowScrape=true',
      expect.objectContaining({ timeout: 60000 }),
    );
  });

  it('forwards allowScrape=false without scraping', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      status: 200,
      data: { name: null, notFound: false },
    });

    await post({ steamId: '76561198000000001', allowScrape: false });

    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'http://proxy.local/api/gamersclub/76561198000000001?allowScrape=false',
      expect.objectContaining({ timeout: 60000 }),
    );
  });

  it('returns a confirmed miss (notFound=true)', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      status: 200,
      data: { name: null, notFound: true },
    });

    const response = await post({ steamId: '76561198000000001' });

    await expect(response.json()).resolves.toEqual({
      steamId: '76561198000000001',
      gcName: null,
      notFound: true,
      unavailable: false,
    });
  });

  it('returns an unconfirmed null (null, notFound=false) on a transient proxy failure', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('proxy down'));

    const response = await post({ steamId: '76561198000000001' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      steamId: '76561198000000001',
      gcName: null,
      notFound: false,
      unavailable: true,
    });
    expect(mockedLogRouteError).toHaveBeenCalledWith(
      'getGamersClubName [local proxy]',
      expect.any(Error),
      { steamId: '76561198000000001' },
    );
  });

  it('flags the lookup as unavailable when the proxy answers with a non-200', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      status: 503,
      data: null,
    });

    const response = await post({ steamId: '76561198000000001' });

    await expect(response.json()).resolves.toEqual({
      steamId: '76561198000000001',
      gcName: null,
      notFound: false,
      unavailable: true,
    });
  });

  it('flags the lookup as unavailable when LOCAL_PROXY_URL is absent', async () => {
    delete process.env.LOCAL_PROXY_URL;

    const response = await post({ steamId: '76561198000000001' });

    await expect(response.json()).resolves.toEqual({
      steamId: '76561198000000001',
      gcName: null,
      notFound: false,
      unavailable: true,
    });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });
});

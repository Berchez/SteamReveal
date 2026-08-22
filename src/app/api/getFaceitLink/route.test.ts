/**
 * @jest-environment node
 */

import axios from 'axios';

export {};

jest.mock('axios');
const mockedAxiosGet = jest.mocked(axios.get);

const { GET } = require('./route') as typeof import('./route');

const VALID_STEAM64 = '76561198146931523'; // 17 digits

const makeRequest = (steamID?: string | null): Request => {
  const url = new URL('http://localhost/api/getFaceitLink');
  if (steamID !== undefined && steamID !== null) {
    url.searchParams.set('steamID', steamID);
  }
  return new Request(url, { method: 'GET' });
};

describe('GET /api/getFaceitLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 if steamID query param is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('INVALID_REQUEST');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-steamid',
    '123', // too short
    '765611981469315231', // too long (18 digits)
    '7656119814693152a', // non-digit char
  ])(
    'returns 400 if steamID (%s) does not match the Steam64 format',
    async (bad) => {
      const res = await GET(makeRequest(bad));
      expect(res.status).toBe(400);
      expect(mockedAxiosGet).not.toHaveBeenCalled();
    },
  );

  it('returns 404 NOT_FOUND when FACEIT has no profile for the steamID', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ status: 404, data: {} } as any);

    const res = await GET(makeRequest(VALID_STEAM64));
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('returns 502 UPSTREAM_ERROR when the FACEIT API errors out', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ status: 500, data: {} } as any);

    const res = await GET(makeRequest(VALID_STEAM64));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error.code).toBe('UPSTREAM_ERROR');
  });

  it('returns 200 with faceitLink and nickname on success', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      status: 200,
      data: {
        faceit_url: 'https://www.faceit.com/{lang}/players/someplayer',
        nickname: 'someplayer',
      },
    } as any);

    const res = await GET(makeRequest(VALID_STEAM64));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      faceitLink: 'https://www.faceit.com/en/players/someplayer',
      nickname: 'someplayer',
    });
  });

  it('URL-encodes the steamID when building the FACEIT request URL', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      status: 200,
      data: { faceit_url: 'x/{lang}/y', nickname: 'n' },
    } as any);

    await GET(makeRequest(VALID_STEAM64));

    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(VALID_STEAM64)),
      expect.anything(),
    );
  });

  it('returns 500 INTERNAL_ERROR when the axios call itself throws', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('network down'));

    const res = await GET(makeRequest(VALID_STEAM64));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error.code).toBe('INTERNAL_ERROR');
  });
});

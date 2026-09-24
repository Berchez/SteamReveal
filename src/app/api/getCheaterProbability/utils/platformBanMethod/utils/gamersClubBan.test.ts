import axios from 'axios';
import getGamersClubBanStatus from './gamersClubBan';

const originalProxyUrl = process.env.LOCAL_PROXY_URL;

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const mockedAxiosGet = jest.mocked(axios.get);

describe('getGamersClubBanStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOCAL_PROXY_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    if (originalProxyUrl === undefined) {
      delete process.env.LOCAL_PROXY_URL;
    } else {
      process.env.LOCAL_PROXY_URL = originalProxyUrl;
    }
  });

  it('returns not-banned when LOCAL_PROXY_URL is missing', async () => {
    delete process.env.LOCAL_PROXY_URL;
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      name: null,
      classification: null,
      matches: null,
      checked: false,
    });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('returns not-banned for an invalid Steam ID without calling the proxy', async () => {
    const res = await getGamersClubBanStatus('not-a-steam-id');
    expect(res).toEqual({
      banned: false,
      reason: null,
      name: null,
      classification: null,
      matches: null,
      checked: false,
    });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('requests the proxy with includeBan=true and parses a non-banned result', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { name: 'SomePlayer', banned: false, banReason: null },
    } as never);
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'http://localhost:3001/api/gamersclub/76561198000000000?includeBan=true',
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(res).toEqual({
      banned: false,
      reason: null,
      name: 'SomePlayer',
      classification: null,
      matches: null,
      checked: true,
    });
  });

  it('parses a banned result with a reason', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { name: 'BadPlayer', banned: true, banReason: 'Punishment' },
    } as never);
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'Punishment',
      name: 'BadPlayer',
      classification: 'other',
      matches: null,
      checked: true,
    });
  });

  it('parses the match/session count from the proxy payload', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { name: 'ActivePlayer', banned: false, sessions: 1250 },
    } as never);
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(res.matches).toBe(1250);
  });

  it('treats an invalid/negative session count as null', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { name: 'X', banned: false, sessions: -5 },
    } as never);
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(res.matches).toBeNull();
  });

  it('strips a trailing slash from LOCAL_PROXY_URL', async () => {
    process.env.LOCAL_PROXY_URL = 'http://localhost:3001/';
    mockedAxiosGet.mockResolvedValueOnce({
      data: { banned: false },
    } as never);
    await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'http://localhost:3001/api/gamersclub/76561198000000000?includeBan=true',
      expect.anything(),
    );
  });

  it('is best-effort on proxy errors', async () => {
    // mockRejectedValueOnce ×2 (not the persistent mockRejectedValue):
    // beforeEach only clearAllMocks (call counts), which does NOT reset a
    // persistent implementation — a sticky rejection would leak into the
    // tests below that expect a success after a single failure.
    mockedAxiosGet
      .mockRejectedValueOnce(new Error('proxy down'))
      .mockRejectedValueOnce(new Error('proxy down'));
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledTimes(2);
    expect(res).toEqual({
      banned: false,
      reason: null,
      name: null,
      classification: null,
      matches: null,
      checked: false,
    });
  });

  it('retries once after a timeout and parses the successful retry', async () => {
    const timeoutError = Object.assign(
      new Error('timeout of 8000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    mockedAxiosGet.mockRejectedValueOnce(timeoutError);
    mockedAxiosGet.mockResolvedValueOnce({
      data: { name: 'SlowPlayer', banned: true, banReason: 'Cheating' },
    } as never);
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledTimes(2);
    expect(res).toEqual({
      banned: true,
      reason: 'Cheating',
      name: 'SlowPlayer',
      classification: 'cheat',
      matches: null,
      checked: true,
    });
  });

  it('retries once after a 5xx and gives up as unchecked after two failures', async () => {
    mockedAxiosGet.mockRejectedValueOnce(
      Object.assign(new Error('proxy 502'), {
        response: { status: 502 },
      }),
    );
    mockedAxiosGet.mockRejectedValueOnce(new Error('still down'));
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledTimes(2);
    expect(res.checked).toBe(false);
    expect(res.banned).toBe(false);
  });

  it('does not retry a 4xx (deterministic auth/session failure)', async () => {
    mockedAxiosGet.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403 },
      }),
    );
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(false);
  });

  it.each([
    ['null payload', null],
    ['empty object', {}],
    ['name without verdict', { name: 'Ghost' }],
    ['non-JSON body', '<html>cloudflare challenge</html>'],
  ])(
    'treats a 200 without a boolean banned verdict as unchecked (%s)',
    async (_label, payload) => {
      mockedAxiosGet.mockResolvedValueOnce({ data: payload } as never);
      const res = await getGamersClubBanStatus('76561198000000000');
      // A 200 that carries no verdict is "unknown", not "verified clean" —
      // and being deterministic it must not burn the retry either.
      expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
      expect(res.banned).toBe(false);
      expect(res.checked).toBe(false);
      expect(res.classification).toBeNull();
    },
  );

  it('does not retry when the proxy response itself is malformed', async () => {
    mockedAxiosGet.mockResolvedValueOnce(undefined as never);
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(false);
    expect(res.banned).toBe(false);
  });
});
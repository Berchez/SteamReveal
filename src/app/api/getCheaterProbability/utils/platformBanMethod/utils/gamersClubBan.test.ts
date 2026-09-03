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
    mockedAxiosGet.mockRejectedValueOnce(new Error('proxy down'));
    const res = await getGamersClubBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      name: null,
      classification: null,
      matches: null,
    });
  });
});